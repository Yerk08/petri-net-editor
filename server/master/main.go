/**
 * @file main.go
 * @brief Точка входа мастера кластера, HTTP API для клиентов и воркеров, CORS middleware.
 */
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"
)

/**
 * @brief Сериализует данные в JSON и отправляет HTTP-ответ с указанным статус-кодом.
 */
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

/**
 * @brief Регистрирует маршруты клиентского API (/api/v1/...) и протокола воркеров (/worker/...).
 * @param mux Экземпляр HTTP-мультиплексора.
 */
func (mc *MasterCluster) registerRoutes(mux *http.ServeMux) {
	// --- CLIENT API ---

	// Возвращает список доступных алгоритмов (id, name)
	mux.HandleFunc("GET /api/v1/get_types", func(w http.ResponseWriter, r *http.Request) {
		mc.plugins.mu.RLock()
		defer mc.plugins.mu.RUnlock()
		list := make([]map[string]string, 0, len(mc.plugins.packages))
		for _, pkg := range mc.plugins.packages {
			list = append(list, map[string]string{"id": pkg.Meta.ID, "name": pkg.Meta.Name})
		}
		writeJSON(w, 200, list)
	})

	// Возвращает JSON-схему входных параметров для выбранного алгоритма
	mux.HandleFunc("GET /api/v1/get_schema", func(w http.ResponseWriter, r *http.Request) {
		mc.plugins.mu.RLock()
		pkg, ok := mc.plugins.packages[r.URL.Query().Get("id")]
		mc.plugins.mu.RUnlock()
		if !ok {
			writeJSON(w, 404, map[string]string{"error": "Algorithm not found"})
			return
		}
		writeJSON(w, 200, pkg.Meta.Schema)
	})

	// Создает и запускает новую задачу анализа
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

		task := &Task{
			ID:      genID("tsk_"),
			Status:  "active",
			Params:  req.Params,
			AlgoPkg: pkg,
		}

		mc.mu.Lock()
		mc.tasks[task.ID] = task
		mc.mu.Unlock()

		mc.stepTask(task, true)

		writeJSON(w, 200, map[string]string{"taskId": task.ID})
	})

	// Проверяет текущий статус задачи и возвращает краткий итог или ошибку
	mux.HandleFunc("GET /api/v1/check_task", func(w http.ResponseWriter, r *http.Request) {
		mc.mu.RLock()
		task, ok := mc.tasks[r.URL.Query().Get("taskId")]
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

	// Принудительно отменяет задачу и ставит ее активные чанки в очередь прерывания (AbortQueue)
	mux.HandleFunc("POST /api/v1/cancel_task", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			TaskID string `json:"taskId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.TaskID == "" {
			writeJSON(w, 400, map[string]string{"error": "Missing TaskID"})
			return
		}
		mc.mu.Lock()
		defer mc.mu.Unlock()
		task, ok := mc.tasks[req.TaskID]
		if !ok {
			writeJSON(w, 404, map[string]string{"error": "Задача не найдена"})
			return
		}
		for _, ch := range task.Pending {
			ch.Completed = true
			delete(mc.chunkLookup, ch.ID)
			if wrk, exists := mc.workers[ch.AssignedTo]; exists {
				delete(wrk.ActiveChunks, ch.ID)
				wrk.AbortQueue[ch.ID] = true
			}
		}
		mc.finishTaskLocked(task, "cancelled", "", "", "Cancelled by user")
		writeJSON(w, 200, map[string]string{"status": "success"})
	})

	// Возвращает итоговый HTML-отчет завершенной задачи
	mux.HandleFunc("GET /api/v1/get_full_result", func(w http.ResponseWriter, r *http.Request) {
		mc.mu.RLock()
		task, ok := mc.tasks[r.URL.Query().Get("taskId")]
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
			http.Error(w, "Ошибка выполнения задачи: "+task.Error, 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(task.FullHTML))
	})

	// Возвращает сводную телеметрию ресурсов и загрузки кластера
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
			"isAvailable": len(mc.workers) > 0, "onlineWorkers": len(mc.workers),
			"totalCpuCores": cores, "totalRamMb": ram, "totalBenchmarkScore": bench,
			"activeTasksCount": activeTasks, "queuedChunksCount": queuedChunks,
		})
	})

	// --- WORKER API ---

	// Регистрирует новый вычислительный узел в кластере
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
		writeJSON(w, 200, map[string]any{
			"workerId": node.ID, "heartbeatIntervalMs": HeartbeatIntervalMs, "leaseTimeoutMs": LeaseTimeoutMs,
		})
	})

	// Выдает воркеру доступные чанки из очереди с защитой от дублирования BFT-тегов
	mux.HandleFunc("POST /worker/pull", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			WorkerID  string `json:"workerId"`
			FreeSlots int    `json:"freeSlots"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.WorkerID == "" {
			writeJSON(w, 400, map[string]string{"error": "Missing WorkerID"})
			return
		}
		mc.mu.Lock()
		defer mc.mu.Unlock()
		worker, ok := mc.workers[req.WorkerID]
		if !ok {
			w.WriteHeader(404)
			return
		}
		if worker.Banned || req.FreeSlots <= 0 || len(mc.queue) == 0 {
			retry := 500
			if worker.Banned {
				retry = 60000
			}
			writeJSON(w, 200, map[string]any{"chunks": []any{}, "retryAfterMs": retry})
			return
		}

		// Собираем множество активных BFT-тегов воркера за O(ActiveChunks) один раз до цикла
		activeTags := make(map[string]bool, len(worker.ActiveChunks))
		for activeID := range worker.ActiveChunks {
			if act, ok := mc.chunkLookup[activeID]; ok && act.Tag != "" {
				activeTags[act.TaskID+":"+act.Tag] = true
			}
		}

		assigned := make([]map[string]any, 0, req.FreeSlots)
		writeIdx := 0
		i := 0
		for ; i < len(mc.queue); i++ {
			ch := mc.queue[i]
			if ch.Completed {
				continue
			}
			tagKey := ch.TaskID + ":" + ch.Tag
			if ch.Tag != "" && activeTags[tagKey] {
				mc.queue[writeIdx] = ch
				writeIdx++
				continue
			}

			ch.AssignedTo = worker.ID
			worker.ActiveChunks[ch.ID] = true
			if ch.Tag != "" {
				activeTags[tagKey] = true
			}
			assigned = append(assigned, map[string]any{
				"chunkId":        ch.ID,
				"taskId":         ch.TaskID,
				"script":         ch.Script,
				"data":           ch.Data,
				"maxExecutionMs": ch.MaxExecutionMs,
			})

			// Как только слоты заполнены — копируем остаток очереди одним блоком и выходим
			if len(assigned) == req.FreeSlots {
				i++
				break
			}
		}
		if i < len(mc.queue) {
			writeIdx += copy(mc.queue[writeIdx:], mc.queue[i:])
		}
		// Зануляем хвост для сборщика мусора (GC)
		for j := writeIdx; j < len(mc.queue); j++ {
			mc.queue[j] = nil
		}
		mc.queue = mc.queue[:writeIdx]

		writeJSON(w, 200, map[string]any{"chunks": assigned, "retryAfterMs": 500})
	})

	// Обновляет таймер жизни воркера и передает команды управления (ban / abortChunkIds)
	mux.HandleFunc("POST /worker/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			WorkerID string `json:"workerId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.WorkerID == "" {
			writeJSON(w, 400, map[string]string{"error": "Missing WorkerID"})
			return
		}
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
		writeJSON(w, 200, map[string]any{"nextDeadlineMs": LeaseTimeoutMs, "workerCommand": cmd, "abortChunkIds": aborts})
	})

	// Штатно отключает воркер от кластера и переводит его активные чанки в ошибку
	mux.HandleFunc("POST /worker/unregister", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			WorkerID string `json:"workerId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(400)
			return
		}
		mc.mu.Lock()
		defer mc.mu.Unlock()
		if worker, ok := mc.workers[req.WorkerID]; ok {
			mc.failWorkerChunksLocked(worker, "Worker unregistered")
			delete(mc.workers, req.WorkerID)
			writeJSON(w, 200, map[string]string{"status": "unregistered"})
			return
		}
		w.WriteHeader(404)
	})

	// Принимает результат выполнения чанка и возобновляет Lua-корутину по завершении волны
	mux.HandleFunc("POST /worker/submit", func(w http.ResponseWriter, r *http.Request) {
		var req ChunkResult
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(400)
			return
		}
		mc.mu.Lock()
		defer mc.mu.Unlock()
		worker, wOk := mc.workers[req.WorkerID]
		ch, cOk := mc.chunkLookup[req.ChunkID]
		if !wOk || !cOk || ch.AssignedTo != worker.ID {
			w.WriteHeader(400)
			return
		}

		delete(worker.ActiveChunks, ch.ID)
		delete(mc.chunkLookup, ch.ID)
		ch.Completed = true

		if task, ok := mc.tasks[ch.TaskID]; ok && task.Status == "active" {
			delete(task.Pending, ch.ID)
			req.Tag = ch.Tag
			task.BatchRes = append(task.BatchRes, req)
			// Когда все чанки текущей волны отработали (с успехом или ошибкой) — отдаем в Lua
			if len(task.Pending) == 0 {
				go mc.stepTask(task, false)
			}
		}
		writeJSON(w, 200, map[string]string{"status": "accepted"})
	})
}

/**
* @brief HTTP middleware для добавления заголовков Cross-Origin Resource Sharing (CORS).
 */
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

/**
* @brief Инициализирует менеджер плагинов, кластер и запускает HTTP-сервер на порту 5000.
 */
func main() {
	pm := NewPluginManager()
	if err := pm.LoadAll(AlgorithmsDir); err != nil {
		log.Fatalf("Ошибка загрузки алгоритмов: %v", err)
	}
	go pm.Watch(AlgorithmsDir)

	cluster := NewMasterCluster(pm)
	mux := http.NewServeMux()
	cluster.registerRoutes(mux)

	log.Println("Distributed Net Master запущен на http://0.0.0.0:5000")
	log.Fatal(http.ListenAndServe("0.0.0.0:5000", withCORS(mux)))
}
