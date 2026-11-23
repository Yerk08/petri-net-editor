/**
 * @file cluster.go
 * @brief Ядро координации кластера: управление жизненным циклом задач, воркерами и очередью чанков.
 */
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	lua "github.com/yuin/gopher-lua"
)

/**
 * @brief Центральный контроллер распределенного кластера.
 */
type MasterCluster struct {
	mu          sync.RWMutex
	plugins     *PluginManager
	workers     map[string]*WorkerNode
	tasks       map[string]*Task
	chunkLookup map[string]*Chunk
	queue       []*Chunk
}

/**
 * @brief Инициализирует кластер и запускает фоновый монитор таймаутов и очистки памяти.
 * @param pm Менеджер загруженных плагинов алгоритмов.
 */
func NewMasterCluster(pm *PluginManager) *MasterCluster {
	mc := &MasterCluster{
		plugins:     pm,
		workers:     make(map[string]*WorkerNode),
		tasks:       make(map[string]*Task),
		chunkLookup: make(map[string]*Chunk),
	}
	go mc.reapDeadWorkers()
	return mc
}

/**
 * @brief Фоновый цикл: отключает зависшие воркеры по LeaseTimeoutMs и удаляет старые задачи по TTL.
 */
func (mc *MasterCluster) reapDeadWorkers() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		mc.mu.Lock()
		now := time.Now()
		for id, w := range mc.workers {
			if now.Sub(w.LastHeartbeat) > time.Duration(LeaseTimeoutMs)*time.Millisecond {
				log.Printf("[TTL] Воркер %s отключен по таймауту", id)
				mc.failWorkerChunksLocked(w, "Worker heartbeat timeout")
				delete(mc.workers, id)
			}
		}
		// Удаляем завершенные задачи старше MaxTimeRememberMinutes минут, чтобы не текла RAM
		for id, t := range mc.tasks {
			if t.Status != "active" && !t.FinishedAt.IsZero() && now.Sub(t.FinishedAt) > MaxTimeRememberMinutes*time.Minute {
				delete(mc.tasks, id)
			}
		}
		mc.mu.Unlock()
	}
}

/**
 * @brief Помечает все активные чанки отключившегося воркера как WORKER_LOST и передает управление в Lua.
 * @param w Указатель на отключенный воркер.
 * @param reason Причина потери воркера.
 */
func (mc *MasterCluster) failWorkerChunksLocked(w *WorkerNode, reason string) {
	for chunkID := range w.ActiveChunks {
		ch, ok := mc.chunkLookup[chunkID]
		if !ok || ch.Completed {
			continue
		}
		ch.Completed = true
		delete(mc.chunkLookup, chunkID)

		if task, exists := mc.tasks[ch.TaskID]; exists && task.Status == "active" {
			delete(task.Pending, ch.ID)
			task.BatchRes = append(task.BatchRes, ChunkResult{
				ChunkID:      ch.ID,
				Tag:          ch.Tag,
				WorkerID:     w.ID,
				Status:       "error",
				ErrorType:    "WORKER_LOST",
				ErrorMessage: reason,
			})
			if len(task.Pending) == 0 {
				go mc.stepTask(task, false)
			}
		}
	}
	w.ActiveChunks = make(map[string]bool)
}

/**
 * @brief Переводит задачу в финальное состояние, фиксирует время завершения и освобождает ресурсы Lua VM.
 */
func (mc *MasterCluster) finishTaskLocked(t *Task, status, shortRes, htmlRep, errMsg string) {
	t.Status = status
	t.ShortResult = shortRes
	t.FullHTML = htmlRep
	t.Error = errMsg
	t.FinishedAt = time.Now()
	if t.LuaState != nil {
		// Если вызов из cancel_task, TryLock предотвратит закрытие VM прямо во время Resume
		if t.mu.TryLock() {
			t.LuaState.Close()
			t.LuaState = nil
			t.mu.Unlock()
		}
	}
}

/**
 * @brief Запускает или возобновляет Lua-корутину задачи, обрабатывает yield с новыми чанками или финал.
 * @param t Указатель на активную задачу.
 * @param initial Флаг первого запуска (true — инициализация VM, false — возобновление после yield).
 */
func (mc *MasterCluster) stepTask(t *Task, initial bool) {
	t.mu.Lock()
	defer t.mu.Unlock()

	mc.mu.Lock()
	if t.Status != "active" {
		mc.mu.Unlock()
		return
	}
	batchRes := t.BatchRes
	t.BatchRes = nil
	mc.mu.Unlock()

	var fn *lua.LFunction
	var args []lua.LValue

	if initial {
		L := newSandboxedLuaState()
		if err := L.DoString(t.AlgoPkg.LuaCode); err != nil {
			L.Close()
			mc.mu.Lock()
			mc.finishTaskLocked(t, "failed", "", "", err.Error())
			mc.mu.Unlock()
			return
		}
		mainFn, ok := L.GetGlobal("main").(*lua.LFunction)
		if !ok {
			L.Close()
			mc.mu.Lock()
			mc.finishTaskLocked(t, "failed", "", "", "функция main не найдена в orchestrator.lua")
			mc.mu.Unlock()
			return
		}
		thread, _ := L.NewThread()
		t.LuaState = L
		t.LuaThread = thread
		fn = mainFn
		args = []lua.LValue{mc.buildLuaContext(L, t)}
	} else {
		args = []lua.LValue{goToLua(t.LuaState, batchRes)}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	t.LuaState.SetContext(ctx)
	state, err, retVals := t.LuaState.Resume(t.LuaThread, fn, args...)
	cancel()

	// Вспомогательная функция безопасного завершения с закрытием Lua VM под обоими мьютексами
	failOrFinish := func(status, shortRes, htmlRep, errMsg string) {
		if t.LuaState != nil {
			t.LuaState.Close()
			t.LuaState = nil
		}
		mc.mu.Lock()
		defer mc.mu.Unlock()
		if t.Status == "active" {
			mc.finishTaskLocked(t, status, shortRes, htmlRep, errMsg)
		}
	}

	if err != nil {
		failOrFinish("failed", "", "", "Lua runtime error: "+err.Error())
		return
	}
	if len(retVals) == 0 {
		failOrFinish("failed", "", "", "Lua скрипт завершился без возврата результата")
		return
	}
	resMap, ok := luaToGo(retVals[0]).(map[string]any)
	if !ok {
		failOrFinish("failed", "", "", "Lua должен возвращать таблицу {action=...}")
		return
	}

	// Обработка завершения (успех или явная ошибка от алгоритма)
	if state == lua.ResumeOK {
		if errStr, hasErr := resMap["error"].(string); hasErr && errStr != "" {
			failOrFinish("failed", "", "", errStr)
			return
		}
		shortRes, _ := resMap["short_result"].(string)
		htmlRep, _ := resMap["html_report"].(string)
		failOrFinish("ready", shortRes, htmlRep, "")
		log.Printf("[Task] Задача %s успешно завершена", t.ID)
		return
	}

	// Корутина сделала coroutine.yield({ chunks = { ... } })
	rawChunks, ok := resMap["chunks"].([]any)
	if !ok || len(rawChunks) == 0 {
		failOrFinish("failed", "", "", "yield должен содержать непустой массив chunks")
		return
	}

	// Формируем объекты чанков ДО захвата общего mc.mu.Lock()
	newChunks := make([]*Chunk, 0, len(rawChunks))
	for _, rc := range rawChunks {
		item, ok := rc.(map[string]any)
		if !ok {
			continue
		}
		tag, _ := item["tag"].(string)
		script, _ := item["script"].(string)
		if script == "" {
			script = t.AlgoPkg.WorkerScript
		}
		var dataStr string
		if s, isStr := item["data"].(string); isStr {
			dataStr = s
		} else {
			b, _ := json.Marshal(item["data"])
			dataStr = string(b)
		}
		maxExec := 15000
		if m, ok := item["max_execution_ms"].(float64); ok && m > 0 {
			maxExec = int(m)
		}
		newChunks = append(newChunks, &Chunk{
			ID:             genID("chk_"),
			TaskID:         t.ID,
			Tag:            tag,
			Data:           dataStr,
			Script:         script,
			MaxExecutionMs: maxExec,
		})
	}

	// Забираем глобальный мьютекс на микросекунды только для вставки в очередь
	mc.mu.Lock()
	defer mc.mu.Unlock()
	if t.Status != "active" {
		if t.LuaState != nil {
			t.LuaState.Close()
			t.LuaState = nil
		}
		return
	}

	t.Pending = make(map[string]*Chunk, len(newChunks))
	for _, ch := range newChunks {
		t.Pending[ch.ID] = ch
		mc.chunkLookup[ch.ID] = ch
	}
	mc.queue = append(mc.queue, newChunks...)
	fmt.Printf("[Task] %s поставила в очередь %d чанков\n", t.ID, len(t.Pending))
}
