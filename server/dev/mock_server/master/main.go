package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	lua "github.com/yuin/gopher-lua"
)

// Константы конфигурации кластера
const (
	AlgorithmsDir       = "./algorithms"
	HeartbeatIntervalMs = 3000
	LeaseTimeoutMs      = 10000
	BFTReplicas         = 2 // Количество дублей для BFT-сверки (кворум = 2)
	MaxStrikesBeforeBan = 3
)

func genID(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// ============================================================================
// 1. МОДЕЛИ ДАННЫХ (OpenAPI Contract)
// ============================================================================

type AlgorithmMeta struct {
	ID     string           `json:"id"`
	Name   string           `json:"name"`
	Schema []map[string]any `json:"schema"`
}

type AlgorithmPackage struct {
	Meta         AlgorithmMeta
	Version      int
	LuaCode      string
	WorkerScript string
}

type WorkerNode struct {
	ID             string    `json:"workerId"`
	Arch           string    `json:"arch"`
	OS             string    `json:"os"`
	CPUCores       int       `json:"cpu_cores"`
	RAMMb          int       `json:"ram_mb"`
	BenchmarkScore int       `json:"benchmark_score"`
	LastHeartbeat  time.Time `json:"-"`
	Strikes        int       `json:"-"`
	Banned         bool      `json:"-"`
	ActiveChunks   map[string]bool
	AbortQueue     map[string]bool
}

type Chunk struct {
	ID             string
	TaskID         string
	PayloadJSON    string
	Script         string
	MaxExecutionMs int
	AssignedTo     string // workerId или "" если в очереди
	Completed      bool
}

type LogicalChunk struct {
	Index          int
	Replicas       []*Chunk
	Votes          map[string]int    // output -> count
	WorkerOutputs  map[string]string // workerId -> output
	VerifiedOutput string
	IsVerified     bool
}

type Task struct {
	ID          string
	Status      string // active, ready, failed, cancelled
	AlgoPkg     *AlgorithmPackage
	Chunks      []*LogicalChunk
	ShortResult string
	FullHTML    string
	Error       string
}

// ============================================================================
// 2. LUA-ДВИЖОК (Песочница без os / io)
// ============================================================================

func newSandboxedLuaState() *lua.LState {
	L := lua.NewState(lua.Options{SkipOpenLibs: true})
	for _, pair := range []struct {
		n string
		f lua.LGFunction
	}{
		{lua.LoadLibName, lua.OpenPackage},
		{lua.BaseLibName, lua.OpenBase},
		{lua.TabLibName, lua.OpenTable},
		{lua.StringLibName, lua.OpenString},
		{lua.MathLibName, lua.OpenMath},
	} {
		L.Push(L.NewFunction(pair.f))
		L.Push(lua.LString(pair.n))
		L.Call(1, 0)
	}
	// Блокируем небезопасные глобальные функции
	L.SetGlobal("dofile", lua.LNil)
	L.SetGlobal("loadfile", lua.LNil)
	L.SetGlobal("require", lua.LNil)
	return L
}

func goToLua(L *lua.LState, val any) lua.LValue {
	if val == nil {
		return lua.LNil
	}
	switch v := val.(type) {
	case bool:
		return lua.LBool(v)
	case float64:
		return lua.LNumber(v)
	case int:
		return lua.LNumber(v)
	case string:
		return lua.LString(v)
	case []any:
		tbl := L.NewTable()
		for i, item := range v {
			tbl.RawSetInt(i+1, goToLua(L, item))
		}
		return tbl
	case map[string]any:
		tbl := L.NewTable()
		for k, item := range v {
			tbl.RawSetString(k, goToLua(L, item))
		}
		return tbl
	default:
		b, _ := json.Marshal(v)
		return lua.LString(string(b))
	}
}

func luaToGo(lv lua.LValue) any {
	switch v := lv.(type) {
	case *lua.LNilType:
		return nil
	case lua.LBool:
		return bool(v)
	case lua.LNumber:
		return float64(v)
	case lua.LString:
		return string(v)
	case *lua.LTable:
		maxN := v.MaxN()
		if maxN > 0 {
			arr := make([]any, 0, maxN)
			for i := 1; i <= maxN; i++ {
				arr = append(arr, luaToGo(v.RawGetInt(i)))
			}
			return arr
		}
		m := make(map[string]any)
		v.ForEach(func(k, val lua.LValue) {
			m[k.String()] = luaToGo(val)
		})
		return m
	default:
		return lv.String()
	}
}

// ============================================================================
// 3. ПЛАГИН-МЕНЕДЖЕР С HOT RELOAD
// ============================================================================

type PluginManager struct {
	mu       sync.RWMutex
	packages map[string]*AlgorithmPackage
}

func NewPluginManager() *PluginManager {
	return &PluginManager{
		packages: make(map[string]*AlgorithmPackage),
	}
}

func (pm *PluginManager) LoadAll(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			_ = pm.LoadPackage(filepath.Join(dir, entry.Name()))
		}
	}
	return nil
}

func (pm *PluginManager) LoadPackage(pkgPath string) error {
	metaBytes, err := os.ReadFile(filepath.Join(pkgPath, "meta.json"))
	if err != nil {
		return err
	}
	var meta AlgorithmMeta
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		return err
	}

	luaBytes, err := os.ReadFile(filepath.Join(pkgPath, "orchestrator.lua"))
	if err != nil {
		return err
	}

	pyBytes, err := os.ReadFile(filepath.Join(pkgPath, "worker_algo.py"))
	if err != nil {
		return err
	}

	// Валидация синтаксиса Lua перед регистрацией
	L := newSandboxedLuaState()
	defer L.Close()
	if err := L.DoString(string(luaBytes)); err != nil {
		log.Printf("[PluginManager] Ошибка компиляции %s: %v", meta.ID, err)
		return err
	}

	pm.mu.Lock()
	defer pm.mu.Unlock()
	ver := 1
	if old, exists := pm.packages[meta.ID]; exists {
		ver = old.Version + 1
	}
	pm.packages[meta.ID] = &AlgorithmPackage{
		Meta:         meta,
		Version:      ver,
		LuaCode:      string(luaBytes),
		WorkerScript: string(pyBytes),
	}
	log.Printf("[PluginManager] Загружен пакет '%s' (v%d)", meta.ID, ver)
	return nil
}

func (pm *PluginManager) Watch(dir string) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("[Watcher] Ошибка запуска: %v", err)
		return
	}
	defer watcher.Close()

	_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err == nil && info.IsDir() {
			_ = watcher.Add(path)
		}
		return nil
	})

	for {
		select {
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}
			if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) {
				pkgDir := filepath.Dir(event.Name)
				if pkgDir != dir {
					time.Sleep(100 * time.Millisecond) // Debounce
					_ = pm.LoadPackage(pkgDir)
				}
			}
		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			log.Printf("[Watcher] Ошибка: %v", err)
		}
	}
}

// ============================================================================
// 4. ЯДРО ПЛАНИРОВЩИКА И BFT-КОНТРОЛЛЕР
// ============================================================================

type MasterCluster struct {
	mu          sync.RWMutex
	plugins     *PluginManager
	workers     map[string]*WorkerNode
	tasks       map[string]*Task
	chunkLookup map[string]*Chunk
	logicalRef  map[string]*LogicalChunk
	queue       []*Chunk
}

func NewMasterCluster(pm *PluginManager) *MasterCluster {
	mc := &MasterCluster{
		plugins:     pm,
		workers:     make(map[string]*WorkerNode),
		tasks:       make(map[string]*Task),
		chunkLookup: make(map[string]*Chunk),
		logicalRef:  make(map[string]*LogicalChunk),
		queue:       make([]*Chunk, 0),
	}
	go mc.reapDeadWorkers()
	return mc
}

// Фоновый контроль TTL воркеров
func (mc *MasterCluster) reapDeadWorkers() {
	ticker := time.NewTicker(1 * time.Second)
	for range ticker.C {
		mc.mu.Lock()
		now := time.Now()
		for id, w := range mc.workers {
			if now.Sub(w.LastHeartbeat) > time.Duration(LeaseTimeoutMs)*time.Millisecond {
				log.Printf("[TTL] Воркер %s отключен по таймауту. Возврат %d чанков в очередь.", id, len(w.ActiveChunks))
				mc.requeueWorkerChunksLocked(w)
				delete(mc.workers, id)
			}
		}
		mc.mu.Unlock()
	}
}

func (mc *MasterCluster) requeueWorkerChunksLocked(w *WorkerNode) {
	for chunkID := range w.ActiveChunks {
		if ch, ok := mc.chunkLookup[chunkID]; ok && !ch.Completed {
			ch.AssignedTo = ""
			mc.queue = append(mc.queue, ch)
		}
	}
	w.ActiveChunks = make(map[string]bool)
}

func (mc *MasterCluster) runLuaSplit(pkg *AlgorithmPackage, params map[string]any) ([]string, error) {
	L := newSandboxedLuaState()
	defer L.Close()
	if err := L.DoString(pkg.LuaCode); err != nil {
		return nil, err
	}
	fn := L.GetGlobal("split")
	if fn.Type() != lua.LTFunction {
		return nil, fmt.Errorf("функция split не найдена в orchestrator.lua")
	}
	if err := L.CallByParam(lua.P{Fn: fn, NRet: 1, Protect: true}, goToLua(L, params)); err != nil {
		return nil, err
	}
	res := luaToGo(L.Get(-1))
	L.Pop(1)

	arr, ok := res.([]any)
	if !ok {
		return nil, fmt.Errorf("split должен возвращать массив таблиц")
	}
	payloads := make([]string, 0, len(arr))
	for _, item := range arr {
		b, _ := json.Marshal(item)
		payloads = append(payloads, string(b))
	}
	return payloads, nil
}

func (mc *MasterCluster) runLuaMerge(pkg *AlgorithmPackage, results []any) (string, string, error) {
	L := newSandboxedLuaState()
	defer L.Close()
	if err := L.DoString(pkg.LuaCode); err != nil {
		return "", "", err
	}
	fn := L.GetGlobal("merge")
	if fn.Type() != lua.LTFunction {
		return "", "", fmt.Errorf("функция merge не найдена в orchestrator.lua")
	}
	if err := L.CallByParam(lua.P{Fn: fn, NRet: 1, Protect: true}, goToLua(L, results)); err != nil {
		return "", "", err
	}
	res := luaToGo(L.Get(-1))
	L.Pop(1)

	m, ok := res.(map[string]any)
	if !ok {
		return "", "", fmt.Errorf("merge должен возвращать таблицу {short_result, html_report}")
	}
	shortRes, _ := m["short_result"].(string)
	htmlRep, _ := m["html_report"].(string)
	return shortRes, htmlRep, nil
}

// ============================================================================
// 5. HTTP ОБРАБОТЧИКИ (Client API & Worker API)
// ============================================================================

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func (mc *MasterCluster) registerRoutes(mux *http.ServeMux) {
	// --- CLIENT API ---
	mux.HandleFunc("GET /api/v1/get_types", func(w http.ResponseWriter, r *http.Request) {
		mc.plugins.mu.RLock()
		defer mc.plugins.mu.RUnlock()
		list := make([]map[string]string, 0, len(mc.plugins.packages))
		for _, pkg := range mc.plugins.packages {
			list = append(list, map[string]string{
				"id":   pkg.Meta.ID,
				"name": pkg.Meta.Name,
			})
		}
		writeJSON(w, 200, list)
	})
	mux.HandleFunc("GET /api/v1/get_schema", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		mc.plugins.mu.RLock()
		pkg, ok := mc.plugins.packages[id]
		mc.plugins.mu.RUnlock()
		if !ok {
			writeJSON(w, 404, map[string]string{"error": "Algorithm not found"})
			return
		}
		writeJSON(w, 200, pkg.Meta.Schema)
	})
	mux.HandleFunc("POST /api/v1/submit_task", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			AnalysisType string         `json:"analysis_type"`
			Params       map[string]any `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AnalysisType == "" {
			writeJSON(w, 400, map[string]string{"error": "Missing analysis_type"})
			return
		}
		mc.plugins.mu.RLock()
		pkg, ok := mc.plugins.packages[req.AnalysisType]
		mc.plugins.mu.RUnlock()
		if !ok {
			writeJSON(w, 400, map[string]string{"error": "Unknown analysis_type"})
			return
		}
		payloads, err := mc.runLuaSplit(pkg, req.Params)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		taskID := genID("tsk_")
		task := &Task{
			ID:      taskID,
			Status:  "active",
			AlgoPkg: pkg,
			Chunks:  make([]*LogicalChunk, 0, len(payloads)),
		}
		mc.mu.Lock()
		for idx, payload := range payloads {
			lc := &LogicalChunk{
				Index:         idx,
				Votes:         make(map[string]int),
				WorkerOutputs: make(map[string]string),
			}
			// Вшиваем JSON-данные подзадачи в шаблон Python-скрипта
			fullScript := fmt.Sprintf("CHUNK_DATA_JSON = %q\n\n%s", payload, pkg.WorkerScript)
			for rep := 0; rep < BFTReplicas; rep++ {
				ch := &Chunk{
					ID:             genID("chk_"),
					TaskID:         taskID,
					PayloadJSON:    payload,
					Script:         fullScript,
					MaxExecutionMs: 15000,
				}
				lc.Replicas = append(lc.Replicas, ch)
				mc.chunkLookup[ch.ID] = ch
				mc.logicalRef[ch.ID] = lc
				mc.queue = append(mc.queue, ch)
			}
			task.Chunks = append(task.Chunks, lc)
		}
		mc.tasks[taskID] = task
		mc.mu.Unlock()
		writeJSON(w, 200, map[string]string{"taskId": taskID})
	})
	mux.HandleFunc("GET /api/v1/check_task", func(w http.ResponseWriter, r *http.Request) {
		taskID := r.URL.Query().Get("taskId")
		mc.mu.RLock()
		task, ok := mc.tasks[taskID]
		mc.mu.RUnlock()
		if !ok {
			writeJSON(w, 404, map[string]string{"status": "failed", "error": "Задача не найдена"})
			return
		}
		resp := map[string]any{"status": task.Status}
		switch task.Status {
		case "ready":
			resp["short_result"] = task.ShortResult
		case "failed":
			resp["error"] = task.Error
		}
		writeJSON(w, 200, resp)
	})
	mux.HandleFunc("POST /api/v1/cancel_task", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			TaskID string `json:"taskId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		mc.mu.Lock()
		defer mc.mu.Unlock()
		task, ok := mc.tasks[req.TaskID]
		if !ok {
			writeJSON(w, 404, map[string]string{"error": "Задача не найдена"})
			return
		}
		task.Status = "cancelled"
		// Помечаем все реплики как завершенные и рассылаем abort_chunk активным воркерам
		for _, lc := range task.Chunks {
			for _, ch := range lc.Replicas {
				ch.Completed = true
				if ch.AssignedTo != "" {
					if worker, exists := mc.workers[ch.AssignedTo]; exists {
						worker.AbortQueue[ch.ID] = true
					}
				}
			}
		}
		writeJSON(w, 200, map[string]string{"status": "success", "message": "Task cancelled"})
	})
	mux.HandleFunc("GET /api/v1/get_full_result", func(w http.ResponseWriter, r *http.Request) {
		taskID := r.URL.Query().Get("taskId")
		mc.mu.RLock()
		task, ok := mc.tasks[taskID]
		mc.mu.RUnlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		if task.Status == "active" {
			w.WriteHeader(409)
			return
		}
		if task.Status == "failed" {
			w.WriteHeader(500)
			_, _ = w.Write([]byte("Ошибка выполнения задачи" + task.Error + ""))
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(task.FullHTML))
	})
	mux.HandleFunc("GET /api/v1/cluster_status", func(w http.ResponseWriter, r *http.Request) {
		mc.mu.RLock()
		defer mc.mu.RUnlock()
		var cores, ram, bench, activeTasks, queuedChunks int
		for _, wrk := range mc.workers {
			if !wrk.Banned {
				cores += wrk.CPUCores
				ram += wrk.RAMMb
				bench += wrk.BenchmarkScore
			}
		}
		for _, t := range mc.tasks {
			if t.Status == "active" {
				activeTasks++
			}
		}
		for _, ch := range mc.queue {
			if !ch.Completed && ch.AssignedTo == "" {
				queuedChunks++
			}
		}
		writeJSON(w, 200, map[string]any{
			"isAvailable":         len(mc.workers) > 0,
			"onlineWorkers":       len(mc.workers),
			"totalCpuCores":       cores,
			"totalRamMb":          ram,
			"totalBenchmarkScore": bench,
			"activeTasksCount":    activeTasks,
			"queuedChunksCount":   queuedChunks,
		})
	})
	// --- WORKER API ---
	mux.HandleFunc("POST /worker/register", func(w http.ResponseWriter, r *http.Request) {
		var node WorkerNode
		if err := json.NewDecoder(r.Body).Decode(&node); err != nil {
			w.WriteHeader(400)
			return
		}
		node.ID = genID("wrk_")
		node.LastHeartbeat = time.Now()
		node.ActiveChunks = make(map[string]bool)
		node.AbortQueue = make(map[string]bool)
		mc.mu.Lock()
		mc.workers[node.ID] = &node
		mc.mu.Unlock()
		log.Printf("[Cluster] Зарегистрирован воркер %s (%s/%s, %d CPU)", node.ID, node.OS, node.Arch, node.CPUCores)
		writeJSON(w, 200, map[string]any{
			"workerId":            node.ID,
			"heartbeatIntervalMs": HeartbeatIntervalMs,
			"leaseTimeoutMs":      LeaseTimeoutMs,
		})
	})
	mux.HandleFunc("POST /worker/pull", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			WorkerID       string `json:"workerId"`
			FreeSlots      int    `json:"freeSlots"`
			AvailableRamMb int    `json:"availableRamMb"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		mc.mu.Lock()
		defer mc.mu.Unlock()
		worker, ok := mc.workers[req.WorkerID]
		if !ok {
			w.WriteHeader(404)
			return
		}
		if worker.Banned {
			writeJSON(w, 200, map[string]any{"chunks": []any{}, "retryAfterMs": 60000})
			return
		}
		assigned := make([]map[string]any, 0, req.FreeSlots)
		remainingQueue := make([]*Chunk, 0, len(mc.queue))
		for _, ch := range mc.queue {
			if ch.Completed {
				continue // Пропускаем отмененные или уже решившие кворум чанки
			}
			lc := mc.logicalRef[ch.ID]
			// BFT правило: один воркер не может считать две реплики одного и того же логического чанка
			alreadyRunningSameLogical := false
			for _, rep := range lc.Replicas {
				if rep.AssignedTo == worker.ID || lc.WorkerOutputs[worker.ID] != "" {
					alreadyRunningSameLogical = true
					break
				}
			}
			if len(assigned) < req.FreeSlots && !alreadyRunningSameLogical {
				ch.AssignedTo = worker.ID
				worker.ActiveChunks[ch.ID] = true
				assigned = append(assigned, map[string]any{
					"chunkId":        ch.ID,
					"taskId":         ch.TaskID,
					"script":         ch.Script,
					"maxExecutionMs": ch.MaxExecutionMs,
				})
			} else {
				remainingQueue = append(remainingQueue, ch)
			}
		}
		mc.queue = remainingQueue
		writeJSON(w, 200, map[string]any{
			"chunks":       assigned,
			"retryAfterMs": 2000,
		})
	})
	mux.HandleFunc("POST /worker/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			WorkerID       string   `json:"workerId"`
			ActiveChunkIds []string `json:"activeChunkIds"`
			CPULoadPercent float64  `json:"cpuLoadPercent"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		mc.mu.Lock()
		defer mc.mu.Unlock()
		worker, ok := mc.workers[req.WorkerID]
		if !ok {
			w.WriteHeader(404)
			return
		}
		worker.LastHeartbeat = time.Now()
		aborts := make([]string, 0, len(worker.AbortQueue))
		for cid := range worker.AbortQueue {
			aborts = append(aborts, cid)
		}
		worker.AbortQueue = make(map[string]bool)
		cmd := "continue"
		if worker.Banned {
			cmd = "ban"
		}
		writeJSON(w, 200, map[string]any{
			"nextDeadlineMs": LeaseTimeoutMs,
			"workerCommand":  cmd,
			"abortChunkIds":  aborts,
		})
	})
	mux.HandleFunc("POST /worker/unregister", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			WorkerID string `json:"workerId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		mc.mu.Lock()
		defer mc.mu.Unlock()
		worker, ok := mc.workers[req.WorkerID]
		if !ok {
			w.WriteHeader(404)
			return
		}
		mc.requeueWorkerChunksLocked(worker)
		delete(mc.workers, req.WorkerID)
		writeJSON(w, 200, map[string]string{"status": "unregistered"})
	})
	mux.HandleFunc("POST /worker/submit", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			WorkerID        string `json:"workerId"`
			ChunkID         string `json:"chunkId"`
			Status          string `json:"status"`
			ExecutionTimeMs int    `json:"executionTimeMs"`
			Output          string `json:"output"`
			ErrorType       string `json:"errorType"`
			ErrorMessage    string `json:"errorMessage"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(400)
			return
		}
		mc.mu.Lock()
		worker, wOk := mc.workers[req.WorkerID]
		ch, cOk := mc.chunkLookup[req.ChunkID]
		if !wOk {
			mc.mu.Unlock()
			w.WriteHeader(404)
			return
		}
		if !cOk || ch.AssignedTo != worker.ID {
			mc.mu.Unlock()
			w.WriteHeader(400)
			return
		}
		delete(worker.ActiveChunks, ch.ID)
		// Обработка технического сбоя песочницы (без штрафа репутации)
		if req.Status == "error" {
			log.Printf("[Submit] Сбой песочницы на %s (%s): %s. Переназначение.", worker.ID, req.ErrorType, req.ErrorMessage)
			ch.AssignedTo = ""
			mc.queue = append(mc.queue, ch)
			mc.mu.Unlock()
			writeJSON(w, 200, map[string]string{"status": "accepted"})
			return
		}
		// Успешный расчет -> BFT-сверка
		ch.Completed = true
		lc := mc.logicalRef[ch.ID]
		task := mc.tasks[ch.TaskID]
		if !lc.IsVerified && task.Status == "active" {
			lc.WorkerOutputs[worker.ID] = req.Output
			lc.Votes[req.Output]++
			// Проверка достижения кворума
			if lc.Votes[req.Output] >= BFTReplicas {
				lc.IsVerified = true
				lc.VerifiedOutput = req.Output
				// Штрафуем воркеров, приславших неверный результат
				for wID, out := range lc.WorkerOutputs {
					if out != req.Output {
						if badWorker, exists := mc.workers[wID]; exists {
							badWorker.Strikes++
							log.Printf("[BFT] Воркер %s нарушил кворум (страйк %d/%d)", wID, badWorker.Strikes, MaxStrikesBeforeBan)
							if badWorker.Strikes >= MaxStrikesBeforeBan {
								badWorker.Banned = true
								log.Printf("[BFT] Воркер %s ЗАБЛОКИРОВАН!", wID)
							}
						}
					}
				}
				// Отменяем лишние реплики у других воркеров
				for _, rep := range lc.Replicas {
					if !rep.Completed {
						rep.Completed = true
						if rep.AssignedTo != "" {
							if otherW, exists := mc.workers[rep.AssignedTo]; exists {
								otherW.AbortQueue[rep.ID] = true
							}
						}
					}
				}
			} else if len(lc.WorkerOutputs) == len(lc.Replicas) {
				// Все реплики отработали, но кворума нет -> добавляем еще одну реплику для разрешения конфликта
				extraCh := &Chunk{
					ID:             genID("chk"),
					TaskID:         task.ID,
					PayloadJSON:    ch.PayloadJSON,
					Script:         ch.Script,
					MaxExecutionMs: ch.MaxExecutionMs,
				}
				lc.Replicas = append(lc.Replicas, extraCh)
				mc.chunkLookup[extraCh.ID] = extraCh
				mc.logicalRef[extraCh.ID] = lc
				mc.queue = append(mc.queue, extraCh)
			}
		}
		// Проверяем, все ли логические чанки задачи верифицированы
		allDone := true
		verifiedResults := make([]any, 0, len(task.Chunks))
		for _, item := range task.Chunks {
			if !item.IsVerified {
				allDone = false
				break
			}
			var parsed any
			_ = json.Unmarshal([]byte(item.VerifiedOutput), &parsed)
			verifiedResults = append(verifiedResults, parsed)
		}
		pkg := task.AlgoPkg
		shouldMerge := allDone && task.Status == "active"
		mc.mu.Unlock()
		// Запускаем Lua merge за пределами мьютекса
		if shouldMerge {
			shortRes, htmlRep, err := mc.runLuaMerge(pkg, verifiedResults)
			mc.mu.Lock()
			if err != nil {
				task.Status = "failed"
				task.Error = "Ошибка агрегации (merge): " + err.Error()
			} else {
				task.Status = "ready"
				task.ShortResult = shortRes
				task.FullHTML = htmlRep
			}
			mc.mu.Unlock()
			log.Printf("[Task] Задача %s завершена со статусом: %s", task.ID, task.Status)
		}
		writeJSON(w, 200, map[string]string{"status": "accepted"})
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		// Отвечаем на preflight-запросы браузера сразу со статусом 204
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func main() {
	pm := NewPluginManager()
	if err := pm.LoadAll(AlgorithmsDir); err != nil {
		log.Fatalf("Ошибка загрузки алгоритмов из %s: %v", AlgorithmsDir, err)
	}
	go pm.Watch(AlgorithmsDir)
	cluster := NewMasterCluster(pm)
	mux := http.NewServeMux()
	cluster.registerRoutes(mux)
	addr := "0.0.0.0:5000"
	log.Printf("Distributed Petri Net Master запущен на http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, withCORS(mux)))
}
