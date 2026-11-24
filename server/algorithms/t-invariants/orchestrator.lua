function main(ctx)
    local transitions = ctx.params.transitions
    if not transitions or type(transitions) ~= "table" or #transitions == 0 then
        return { error = "Не заданы переходы сети Петри." }
    end

    local max_retries = tonumber(ctx.config.max_retries) or 2
    local timeout_ms = tonumber(ctx.config.max_execution_ms) or 15000
    local result_json = nil

    for attempt = 1, max_retries + 1 do
        local results = coroutine.yield({
            chunks = {
                {
                    tag = "t_inv",
                    data = { transitions = transitions },
                    max_execution_ms = timeout_ms
                }
            }
        })

        local res = results[1]
        if res.status == "ok" then
            result_json = res.output
            break
        elseif res.errorType == "SyntaxError" or res.errorType == "FatalAlgorithmError" then
            return { error = "Ошибка в коде алгоритма: " .. (res.errorMessage or "") }
        end
    end

    if not result_json then
        return { error = "Не удалось выполнить расчет на воркере." }
    end

    local data = ctx.json_decode(result_json)
    local t_names = data.transitions or {}
    local invariants = data.invariants or {}
    local uncovered = data.uncovered_transitions or {}

    local is_consistent = (#uncovered == 0 and #t_names > 0)
    local short_res = string.format(
        "Найдено T-инвариантов: %d. Сеть %s.",
        #invariants,
        is_consistent and "согласована" or "НЕ согласована"
    )

    local headers = ""
    for _, t in ipairs(t_names) do
        headers = headers .. string.format("<th>%s</th>", t)
    end

    local rows = ""
    for idx, inv in ipairs(invariants) do
        local cells = ""
        local seq = {}
        for i, count in ipairs(inv) do
            cells = cells .. string.format("<td>%d</td>", count)
            if count > 0 then
                table.insert(seq, (count == 1 and "" or count .. "*") .. t_names[i])
            end
        end
        rows = rows .. string.format("<tr><td>x_%d</td>%s<td><code>%s</code></td></tr>", idx, cells, table.concat(seq, ", "))
    end

    local html = string.format([[
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: sans-serif; margin: 20px; }
  table { border-collapse: collapse; margin-top: 10px; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: center; }
</style></head>
<body>
  <h2>T-инварианты (C &middot; x = 0)</h2>
  <p><b>Согласованность (Consistency):</b> %s | <b>Непокрытые переходы:</b> %s</p>
  <table>
    <thead><tr><th>#</th>%s<th>Цикл переходов</th></tr></thead>
    <tbody>%s</tbody>
  </table>
</body>
</html>]],
        is_consistent and "Да" or "Нет",
        #uncovered > 0 and table.concat(uncovered, ", ") or "нет",
        headers,
        #rows > 0 and rows or "<tr><td colspan='100'>Нет нетривиальных T-инвариантов</td></tr>"
    )

    return { short_result = short_res, html_report = html }
end

