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
                    tag = "p_inv",
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
    if data.error then
        return { error = data.error }
    end

    local places = data.places or {}
    local invariants = data.invariants or {}
    local uncovered = data.uncovered_places or {}

    local is_conservative = (#uncovered == 0 and #places > 0)
    local short_res = string.format(
        "Найдено P-инвариантов: %d. Сеть %s.",
        #invariants,
        is_conservative and "консервативна" or "НЕ консервативна"
    )

    local headers = ""
    for _, p in ipairs(places) do
        headers = headers .. string.format("<th>%s</th>", p)
    end

    local rows = ""
    for idx, inv in ipairs(invariants) do
        local cells = ""
        local eq = {}
        for i, w in ipairs(inv) do
            cells = cells .. string.format("<td>%d</td>", w)
            if w > 0 then
                table.insert(eq, (w == 1 and "" or w .. "*") .. "M(" .. places[i] .. ")")
            end
        end
        rows = rows .. string.format("<tr><td>y_%d</td>%s<td><code>%s = const</code></td></tr>", idx, cells, table.concat(eq, " + "))
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
  <h2>P-инварианты (y<sup>T</sup> &middot; C = 0)</h2>
  <p><b>Консервативность:</b> %s | <b>Непокрытые позиции:</b> %s</p>
  <table>
    <thead><tr><th>#</th>%s<th>Уравнение</th></tr></thead>
    <tbody>%s</tbody>
  </table>
</body>
</html>]],
        is_conservative and "Да" or "Нет",
        #uncovered > 0 and table.concat(uncovered, ", ") or "нет",
        headers,
        #rows > 0 and rows or "<tr><td colspan='100'>Нет нетривиальных P-инвариантов</td></tr>"
    )

    return { short_result = short_res, html_report = html }
end

