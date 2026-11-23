/**
 * @file plugin_manager.go
 * @brief Менеджер плагинов для загрузки и горячего обновления (hot-reload) алгоритмов.
 */
package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

/**
 * @brief Потокобезопасное хранилище загруженных пакетов алгоритмов.
 */
type PluginManager struct {
	mu       sync.RWMutex
	packages map[string]*AlgorithmPackage
}

/**
 * @brief Создает новый экземпляр менеджера плагинов.
 */
func NewPluginManager() *PluginManager {
	return &PluginManager{packages: make(map[string]*AlgorithmPackage)}
}

/**
 * @brief Сканирует корневую директорию и загружает все найденные пакеты алгоритмов.
 * @param dir Путь к директории с плагинами.
 */
func (pm *PluginManager) LoadAll(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			_ = pm.LoadPackage(filepath.Join(dir, e.Name()))
		}
	}
	return nil
}

/**
 * @brief Читает, валидирует и регистрирует (или обновляет) пакет алгоритма из указанной папки.
 * @param pkgPath Путь к директории конкретного алгоритма (должна содержать meta.json, orchestrator.lua и worker_algo.py).
 */
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

	// Предварительная проверка синтаксиса Lua в изолированном окружении
	L := newSandboxedLuaState()
	defer L.Close()
	if err := L.DoString(string(luaBytes)); err != nil {
		log.Printf("[PluginManager] Ошибка компиляции %s: %v", meta.ID, err)
		return err
	}

	pm.mu.Lock()
	defer pm.mu.Unlock()
	ver := 1
	if old, ok := pm.packages[meta.ID]; ok {
		ver = old.Version + 1
	}
	pm.packages[meta.ID] = &AlgorithmPackage{
		Meta: meta, Version: ver, LuaCode: string(luaBytes), WorkerScript: string(pyBytes),
	}
	log.Printf("[PluginManager] Загружен пакет '%s' (v%d)", meta.ID, ver)
	return nil
}

/**
 * @brief Запускает фоновый мониторинг изменений в директории алгоритмов (hot-reload).
 * @param dir Путь к отслеживаемой директории плагинов.
 */
func (pm *PluginManager) Watch(dir string) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return
	}
	defer watcher.Close()

	_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err == nil && info.IsDir() {
			_ = watcher.Add(path)
		}
		return nil
	})

	for event := range watcher.Events {
		if event.Has(fsnotify.Create) {
			if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
				_ = watcher.Add(event.Name)
				time.Sleep(100 * time.Millisecond)
				_ = pm.LoadPackage(event.Name)
				continue
			}
		}
		if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) || event.Has(fsnotify.Rename) {
			if pkgDir := filepath.Dir(event.Name); pkgDir != dir {
				time.Sleep(100 * time.Millisecond)
				_ = pm.LoadPackage(pkgDir)
			}
		}
	}
}
