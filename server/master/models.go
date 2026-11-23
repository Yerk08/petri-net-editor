/**
 * @file models.go
 * @brief Основные модели данных, структуры кластера и константы конфигурации.
 */
package main

import (
	"crypto/rand"
	"encoding/hex"
	"time"

	lua "github.com/yuin/gopher-lua"
)

/**
 * @brief Константы конфигурации распределенного кластера.
 */
const (
	/** @brief Директория хранения пакетов алгоритмов (плагинов). */
	AlgorithmsDir = "./algorithms"
	/** @brief Рекомендуемый интервал отправки heartbeat-сигналов воркерами (в миллисекундах). */
	HeartbeatIntervalMs = 3000
	/** @brief Таймаут неактивности воркера, после которого его аренда чанков истекает (в миллисекундах). */
	LeaseTimeoutMs = 20000
	/** @brief Время хранения завершенных задач в оперативной памяти до очистки (в минутах). @warning Увеличить при длительных вычислениях. */
	MaxTimeRememberMinutes = 240
	/** @brief Максимальное количество BFT-страйков до перманентной блокировки воркера. */
	MaxStrikesBeforeBan = 1
)

/**
 * @brief Генерирует криптографически случайный строковый идентификатор с заданным префиксом.
 * @param prefix Строковый префикс идентификатора (например, "tsk_", "chk_", "wrk_").
 * @return Уникальный идентификатор в шестнадцатеричном формате.
 */
func genID(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

/**
 * @brief Метаданные плагина алгоритма, загружаемые из файла meta.json.
 */
type AlgorithmMeta struct {
	/** @brief Уникальный машинный идентификатор алгоритма. */
	ID string `json:"id"`
	/** @brief Человекочитаемое название алгоритма для отображения в UI. */
	Name string `json:"name"`
	/** @brief Описание входных параметров формы для клиентского интерфейса. */
	Schema []map[string]any `json:"schema"`
	/** @brief Параметры конфигурации алгоритма, передаваемые в Lua-оркестратор через ctx.config. */
	Config map[string]any `json:"config"`
}

/**
 * @brief Скомпилированный и готовый к исполнению пакет алгоритма.
 */
type AlgorithmPackage struct {
	/** @brief Метаданные и настройки алгоритма. */
	Meta AlgorithmMeta
	/** @brief Порядковый номер версии пакета (увеличивается при hot-reload). */
	Version int
	/** @brief Исходный код координатора задачи (orchestrator.lua). */
	LuaCode string
	/** @brief Исходный код вычислительного модуля для воркеров (worker_algo.py). */
	WorkerScript string
}

/**
 * @brief Представление подключенного вычислительного узла (воркера) в кластере.
 */
type WorkerNode struct {
	/** @brief Уникальный идентификатор воркера в кластере. */
	ID string `json:"workerId"`
	/** @brief Аппаратная архитектура процессора (например, "x86_64", "arm64", "wasm"). */
	Arch string `json:"arch"`
	/** @brief Операционная система или среда выполнения воркера. */
	OS string `json:"os"`
	/** @brief Количество доступных логических ядер процессора. */
	CPUCores int `json:"cpu_cores"`
	/** @brief Общий объем оперативной памяти воркера в мегабайтах. */
	RAMMb int `json:"ram_mb"`
	/** @brief Индекс вычислительной производительности узла по результатам бенчмарка. */
	BenchmarkScore int `json:"benchmark_score"`
	/** @brief Метка времени последнего полученного heartbeat-сигнала. */
	LastHeartbeat time.Time `json:"-"`
	/** @brief Счетчик нарушений (расхождений с BFT-кворумом). */
	Strikes int `json:"-"`
	/** @brief Флаг блокировки узла за недостоверные вычисления. */
	Banned bool `json:"-"`
	/** @brief Множество идентификаторов чанков, выполняемых на воркере в данный момент. */
	ActiveChunks map[string]bool
	/** @brief Очередь идентификаторов чанков, которые воркер должен принудительно прервать. */
	AbortQueue map[string]bool
}

/**
 * @brief Единица распределенной работы (чанк), порождаемая Lua-оркестратором.
 */
type Chunk struct {
	/** @brief Уникальный идентификатор чанка. */
	ID string
	/** @brief Идентификатор родительской задачи. */
	TaskID string
	/** @brief Логический тег от Lua-оркестратора для группировки BFT-реплик. */
	Tag string
	/** @brief Сериализованные входные данные (JSON-строка) для передачи в скрипт воркера. */
	Data string
	/** @brief Python-скрипт для выполнения данного чанка. */
	Script string
	/** @brief Максимально допустимое время выполнения чанка на воркере (в миллисекундах). */
	MaxExecutionMs int
	/** @brief Идентификатор воркера, которому назначен чанк (пустая строка, если в очереди). */
	AssignedTo string
	/** @brief Флаг завершения обработки чанка (успешно, с ошибкой или отменен). */
	Completed bool
}

/**
 * @brief Результат выполнения одного чанка, возвращаемый воркером мастеру и передаваемый в Lua.
 */
type ChunkResult struct {
	/** @brief Идентификатор выполненного чанка. */
	ChunkID string `json:"chunkId"`
	/** @brief Логический тег чанка для сопоставления реплик в Lua. */
	Tag string `json:"tag"`
	/** @brief Идентификатор воркера, приславшего результат. */
	WorkerID string `json:"workerId"`
	/** @brief Статус выполнения ("ok" или "error"). */
	Status string `json:"status"`
	/** @brief Строковый вывод (stdout) скрипта при успешном выполнении. */
	Output string `json:"output"`
	/** @brief Классификация ошибки (например, "SyntaxError", "OOM_OR_TIMEOUT", "WORKER_LOST"). */
	ErrorType string `json:"errorType"`
	/** @brief Подробное описание или стектрейс ошибки. */
	ErrorMessage string `json:"errorMessage"`
}

/**
 * @brief Состояние пользовательской вычислительной задачи на мастере.
 */
type Task struct {
	/** @brief Уникальный идентификатор задачи. */
	ID string
	/** @brief Текущий статус задачи ("active", "ready", "failed", "cancelled"). */
	Status string
	/** @brief Входные параметры задачи, переданные клиентом. */
	Params map[string]any
	/** @brief Ссылка на версию пакета алгоритма, с которой запущена задача. */
	AlgoPkg *AlgorithmPackage
	/** @brief Изолированная виртуальная машина Lua для данной задачи. */
	LuaState *lua.LState
	/** @brief Состояние корутины Lua (поток исполнения функции main). */
	LuaThread *lua.LState
	/** @brief Карта активных (ожидаемых) чанков текущей волны вычислений. */
	Pending map[string]*Chunk
	/** @brief Накопленные результаты текущей волны чанков для передачи в coroutine.yield. */
	BatchRes []ChunkResult
	/** @brief Краткий текстовый итог выполнения задачи. */
	ShortResult string
	/** @brief Полный HTML-отчет о результатах анализа. */
	FullHTML string
	/** @brief Текст ошибки, если задача завершилась со статусом "failed" или "cancelled". */
	Error string
	/** @brief Метка времени завершения задачи (используется для очистки по TTL). */
	FinishedAt time.Time
}
