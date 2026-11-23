-- Формирование списка логических подзадач (ветвей графа достижимости)
local function build_logical_tasks(params)
    local tasks = {}
    local transitions = params.transitions or {}
    local marking = params.initial_marking or {}
    local depth = params.max_depth or 100

    if #transitions == 0 then
        tasks["branch_default"] = {
            start_transition = nil,
            marking = marking,
            transitions = transitions,
            max_depth = depth
        }
    else
        for i, tr in ipairs(transitions) do
            local tag = "branch_" .. i .. "_" .. (tr.name or "unnamed")
            tasks[tag] = {
                start_transition = tr.name,
                marking = marking,
                transitions = transitions,
                max_depth = depth
            }
        end
    end
    return tasks
end

-- Сборка итогового отчета
local function build_report(ctx, verified_outputs, total_branches)
    local total_states = 0
    local deadlocks = {}

    for _, raw_out in pairs(verified_outputs) do
        local res = ctx.json_decode(raw_out)
        if res then
            total_states = total_states + (res.states or 0)
            if res.deadlock_found then
                table.insert(deadlocks, res.branch or "unknown")
            end
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
  <p><b>ID задачи:</b> %s</p>
  <p><b>Итог:</b> %s</p>
  <p><b>Всего проверено подпространств:</b> %d</p>
</body>
</html>
]], ctx.task_id, short_text, total_branches)

    return {
        short_result = short_text,
        html_report = html
    }
end

-- Главная точка входа (корутина)
function main(ctx)
    local quorum = ctx.config.bft_replicas
    local max_rounds = ctx.config.max_bft_rounds
    local chunk_timeout = ctx.config.max_execution_ms or 15000

    local logical_tasks = build_logical_tasks(ctx.params)
    local total_branches = 0
    for _ in pairs(logical_tasks) do
        total_branches = total_branches + 1
    end

    -- Состояние BFT для каждого тега (ветви)
    local state = {}
    for tag, _ in pairs(logical_tasks) do
        state[tag] = {
            votes = {},          -- output_str -> count
            worker_outputs = {}, -- workerId -> output_str
            verified = nil       -- подтвержденный output_str
        }
    end

    for round = 1, max_rounds do
        local batch = {}

        -- Собираем чанки для всех еще не верифицированных ветвей
        for tag, payload in pairs(logical_tasks) do
            local st = state[tag]
            if not st.verified then
                -- В 1-м раунде запускаем quorum реплик, в последующих (если был конфликт/ошибка) — добираем недостающие
                local needed = (round == 1) and quorum or 1
                for _ = 1, needed do
                    table.insert(batch, {
                        tag = tag,
                        data = payload,
                        max_execution_ms = chunk_timeout
                    })
                end
            end
        end

        -- Если все ветви прошли кворум — выходим из цикла
        if #batch == 0 then
            break
        end

        -- Отдаем партию в Go-планировщик и ждем результатов
        local results = coroutine.yield({ chunks = batch })

        -- Обрабатываем ответы текущей волны
        for _, res in ipairs(results) do
            local st = state[res.tag]
            if st and not st.verified then
                if res.status == "error" then
                    -- Если ошибка кода/синтаксиса — сразу прерываем всю задачу для клиента
                    if res.errorType == "SyntaxError" or res.errorType == "FatalAlgorithmError" then
                        return {
                            error = string.format("Ошибка выполнения алгоритма на ветви '%s': %s", res.tag, res.errorMessage or "unknown")
                        }
                    end
                    -- Иначе (например, Timeout/OOM) игнорируем этот результат; ветвь пойдет на ретрай в следующем раунде
                else
                    local out = res.output or ""
                    st.worker_outputs[res.workerId] = out
                    st.votes[out] = (st.votes[out] or 0) + 1

                    -- Проверяем достижение кворума
                    if st.votes[out] >= quorum then
                        st.verified = out
                        -- Выдаем страйки воркерам, приславшим результат, отличный от кворума
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

    -- Финальная проверка: все ли ветви получили BFT-подтверждение
    local verified_outputs = {}
    for tag, st in pairs(state) do
        if not st.verified then
            return {
                error = string.format("Не удалось достичь BFT-кворума для ветви '%s' за %d раундов", tag, max_rounds)
            }
        end
        verified_outputs[tag] = st.verified
    end

    return build_report(ctx, verified_outputs, total_branches)
end
