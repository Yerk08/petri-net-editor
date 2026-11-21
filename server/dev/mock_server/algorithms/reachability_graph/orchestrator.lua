-- Разбиение задачи на независимые подзадачи (чанки)
function split(params)
    local chunks = {}
    local transitions = params.transitions or {}
    local marking = params.initial_marking or {}
    local depth = params.max_depth or 100

    -- Нарезаем по одному чанку на каждый стартовый переход для параллельного обхода ветвей
    if #transitions == 0 then
        table.insert(chunks, {
            start_transition = nil,
            marking = marking,
            transitions = transitions,
            max_depth = depth
        })
    else
        for i, tr in ipairs(transitions) do
            table.insert(chunks, {
                start_transition = tr.name,
                marking = marking,
                transitions = transitions,
                max_depth = depth
            })
        end
    end
    return chunks
end

-- Агрегация верифицированных BFT-результатов в краткий итог и HTML-отчет
function merge(results)
    local total_states = 0
    local deadlocks = {}

    for _, res in ipairs(results) do
        total_states = total_states + (res.states or 0)
        if res.deadlock_found then
            table.insert(deadlocks, res.branch or "unknown")
        end
    end

    local has_deadlock = #deadlocks > 0
    local short_text = string.format(
        "Анализ завершен. Исследовано состояний: %d. Тупики: %s.",
        total_states,
        has_deadlock and ("Обнаружены (" .. table.concat(deadlocks, ", ") .. ")") or "Не обнаружены"
    )

    local html = string.format([[
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Отчет по анализу сети Петри</title></head>
<body>
  <h1>Отчет по построению графа достижимости</h1>
  <p><b>Итог:</b> %s</p>
  <p><b>Всего проверено подпространств:</b> %d</p>
</body>
</html>
]], short_text, #results)

    return {
        short_result = short_text,
        html_report = html
    }
end

