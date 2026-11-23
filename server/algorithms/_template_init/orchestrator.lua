-- ============================================================================
-- ШАБЛОН ОРКЕСТРАТОРА (orchestrator.lua)
-- Демонстрирует все доступные поля ctx и протокол взаимодействия с Go-мастером.
-- ============================================================================

-- Пример вспомогательного Python-скрипта для 2-й волны (динамическая подмена кода чанка)
local REDUCE_PYTHON_SCRIPT = [[
import json

def run_chunk(raw_data):
    payload = json.loads(raw_data)
    total = sum(payload.get("values", []))
    return json.dumps({"final_sum": total}, sort_keys=True, separators=(",", ":"))
]]

-- Главная точка входа (запускается мастером как Lua-корутина)
function main(ctx)
    -- 1. ДОСТУПНЫЕ ПОЛЯ КОНТЕКСТА (ctx):
    -- ctx.task_id (string) - уникальный ID текущей задачи (например, "tsk_a1b2c3d4")
    -- ctx.params  (table)  - параметры от пользователя, соответствующие schema из meta.json
    -- ctx.config  (table)  - статические настройки алгоритма из секции config в meta.json

    local task_id    = ctx.task_id
    local iterations = tonumber(ctx.params.input_number) or 5
    local multiplier = tonumber(ctx.config.custom_multiplier) or 1
    local quorum     = tonumber(ctx.config.bft_replicas) or 2
    local max_rounds = tonumber(ctx.config.max_bft_rounds) or 3
    local timeout_ms = tonumber(ctx.config.max_execution_ms) or 10000

    -- 2. РАБОТА С JSON-УТИЛИТАМИ КОНТЕКСТА:
    -- ctx.json_encode(table) -> string
    -- ctx.json_decode(str)   -> table или nil
    local debug_json = ctx.json_encode({ id = task_id, mult = multiplier })
    local decoded_check = ctx.json_decode(debug_json)

    -- 3. ВОЛНА 1 (MAP): ФОРМИРОВАНИЕ ЧАНКОВ И BFT-КВОРУМ
    -- Подготавливаем 2 логические ветви (тега) для параллельного расчета
    local logical_tags = { "part_alpha", "part_beta" }
    local bft_state = {}
    for _, tag in ipairs(logical_tags) do
        bft_state[tag] = {
            votes = {},          -- output_str -> кол-во совпадений
            worker_outputs = {}, -- workerId -> присланный output_str
            verified = nil       -- подтвержденный результат
        }
    end

    for round = 1, max_rounds do
        local batch = {}

        for idx, tag in ipairs(logical_tags) do
            local st = bft_state[tag]
            if not st.verified then
                local needed = (round == 1) and quorum or 1
                for _ = 1, needed do
                    -- Структура каждого элемента в массиве chunks:
                    -- * tag              (string)       - группировка BFT-реплик (мастер не даст 2 одинаковых тега одному воркеру)
                    -- * data             (table|string) - данные (таблица автоматически сериализуется в JSON)
                    -- * script           (string, опц.) - если не задан, используется worker_algo.py из пакета
                    -- * max_execution_ms (number, опц.) - таймаут выполнения на воркере (по умолчанию 15000)
                    table.insert(batch, {
                        tag = tag,
                        data = {
                            seed = idx * 100,
                            iterations = iterations,
                            multiplier = decoded_check.mult
                        },
                        max_execution_ms = timeout_ms
                    })
                end
            end
        end

        if #batch == 0 then
            break
        end

        -- Приостанавливаем корутину и отправляем партию в очередь Go-мастера.
        -- Когда все чанки партии завершатся, мастер возобновит корутину и вернет массив results.
        local results = coroutine.yield({ chunks = batch })

        -- 4. ОБРАБОТКА ОТВЕТОВ ОТ ВОРКЕРОВ:
        -- Каждый элемент res в results содержит:
        -- * res.chunkId      (string) - ID чанка
        -- * res.tag          (string) - логический тег чанка
        -- * res.workerId     (string) - ID выполнившего воркера
        -- * res.status       (string) - "ok" или "error"
        -- * res.output       (string) - stdout скрипта (при status == "ok")
        -- * res.errorType    (string) - "SyntaxError" | "FatalAlgorithmError" | "OOM_OR_TIMEOUT" | "WORKER_LOST" | "SANDBOX_CRASH"
        -- * res.errorMessage (string) - текст ошибки (при status == "error")
        for _, res in ipairs(results) do
            local st = bft_state[res.tag]
            if st and not st.verified then
                if res.status == "error" then
                    -- Фатальные ошибки кода: дальнейшие раунды бессмысленны, завершаем задачу с ошибкой
                    if res.errorType == "SyntaxError" or res.errorType == "FatalAlgorithmError" then
                        return {
                            error = string.format("Ошибка в Python-скрипте [%s]: %s", res.tag, res.errorMessage or "")
                        }
                    end
                    -- Ошибки инфраструктуры ("WORKER_LOST", "OOM_OR_TIMEOUT") игнорируем — ветвь пересчитается в следующем раунде
                else
                    local out = res.output or ""
                    st.worker_outputs[res.workerId] = out
                    st.votes[out] = (st.votes[out] or 0) + 1

                    if st.votes[out] >= quorum then
                        st.verified = out
                        -- 5. НАКАЗАНИЕ НЕДОБРОСОВЕСТНЫХ ВОРКЕРОВ:
                        -- ctx.strike_worker(workerId) -> начисляет страйк и возвращает true, если воркер забанен
                        for w_id, w_out in pairs(st.worker_outputs) do
                            if w_out ~= out then
                                ctx.strike_worker(w_id)
                            end
                        end
                    end
                end
            end
        end
    end

    -- Собираем верифицированные числа из 1-й волны
    local partial_values = {}
    for _, tag in ipairs(logical_tags) do
        local st = bft_state[tag]
        if not st.verified then
            return { error = "Не удалось собрать BFT-кворум для ветви: " .. tag }
        end
        local parsed = ctx.json_decode(st.verified)
        table.insert(partial_values, parsed and parsed.value or 0)
    end

    -- 6. ВОЛНА 2 (REDUCE): ПРИМЕР ДИНАМИЧЕСКОЙ ПЕРЕДАЧИ ДРУГОГО PYTHON-СКРИПТА
    local reduce_results = coroutine.yield({
        chunks = {
            {
                tag = "final_reduce",
                script = REDUCE_PYTHON_SCRIPT, -- Переопределяем стандартный worker_algo.py
                data = { values = partial_values },
                max_execution_ms = 5000
            }
        }
    })

    local final_res = reduce_results[1]
    if not final_res or final_res.status ~= "ok" then
        return { error = "Ошибка на этапе агрегации: " .. (final_res and final_res.errorMessage or "unknown") }
    end

    local final_obj = ctx.json_decode(final_res.output) or {}
    local total_sum = final_obj.final_sum or 0

    -- 7. ВОЗВРАТ ФИНАЛЬНОГО РЕЗУЛЬТАТА КЛИЕНТУ:
    -- Возвращаемая таблица при успешном завершении (return без yield) должна содержать:
    -- * short_result (string) - краткая сводка для эндпоинта GET /api/v1/check_task
    -- * html_report  (string) - полный HTML-документ для эндпоинта GET /api/v1/get_full_result
    -- (Либо поле error = "текст", если нужно завершить задачу со статусом "failed")
    local short_summary = string.format("Шаблон выполнен успешно. Итоговая сумма: %d", total_sum)
    local html_page = string.format([[
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Результат %s</title></head>
<body>
  <h2>Отчет шаблонного алгоритма</h2>
  <p><b>ID задачи:</b> %s</p>
  <p><b>Промежуточные значения:</b> %s</p>
  <p><b>Итоговый результат (Reduce):</b> %d</p>
</body>
</html>
]], task_id, task_id, table.concat(partial_values, ", "), total_sum)

    return {
        short_result = short_summary,
        html_report = html_page
    }
end
