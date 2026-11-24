function main(ctx)
    local transitions = ctx.params.transitions
    if not transitions or type(transitions) ~= "table" or #transitions == 0 then
        return { error = "Не заданы переходы сети Петри." }
    end

    local max_retries = tonumber(ctx.config.max_retries) or 2
    local timeout_ms = tonumber(ctx.config.max_execution_ms) or 15000
    local outputs = {}

    for attempt = 1, max_retries + 1 do
        local batch = {}
        for _, mode in ipairs({ "siphons", "traps" }) do
            if not outputs[mode] then
                table.insert(batch, {
                    tag = mode,
                    data = { mode = mode, transitions = transitions },
                    max_execution_ms = timeout_ms
                })
            end
        end

        if #batch == 0 then break end

        local results = coroutine.yield({ chunks = batch })
        for _, res in ipairs(results) do
            if res.status == "ok" then
                outputs[res.tag] = res.output
            elseif res.errorType == "SyntaxError" or res.errorType == "FatalAlgorithmError" then
                return { error = string.format("Ошибка [%s]: %s", res.tag, res.errorMessage or "") }
            end
        end
    end

    if not outputs.siphons or not outputs.traps then
        return { error = "Не удалось завершить расчет сифонов и ловушек." }
    end

    local siphons = (ctx.json_decode(outputs.siphons) or {}).subsets or {}
    local traps = (ctx.json_decode(outputs.traps) or {}).subsets or {}

    local bad_siphons = 0
    local siphon_rows = ""
    for idx, s in ipairs(siphons) do
        local s_set = {}
        for _, p in ipairs(s) do s_set[p] = true end

        local has_trap = false
        for _, tr in ipairs(traps) do
            local is_sub = true
            for _, tp in ipairs(tr) do
                if not s_set[tp] then is_sub = false; break end
            end
            if is_sub then has_trap = true; break end
        end

        if not has_trap then bad_siphons = bad_siphons + 1 end
        siphon_rows = siphon_rows .. string.format(
            "<tr><td>S_%d</td><td>{ %s }</td><td>%s</td></tr>",
            idx, table.concat(s, ", "),
            has_trap and "Да" or "<b>Нет (риск тупика)</b>"
        )
    end

    local trap_rows = ""
    for idx, tr in ipairs(traps) do
        trap_rows = trap_rows .. string.format("<tr><td>Q_%d</td><td>{ %s }</td></tr>", idx, table.concat(tr, ", "))
    end

    local short_res = string.format("Сифонов: %d (без ловушек: %d), ловушек: %d.", #siphons, bad_siphons, #traps)
    local html = string.format([[
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: sans-serif; margin: 20px; }
  .grid { display: flex; gap: 30px; }
  table { border-collapse: collapse; margin-top: 10px; }
  th, td { border: 1px solid #ccc; padding: 6px 12px; text-align: left; }
</style></head>
<body>
  <h2>Минимальные сифоны и ловушки</h2>
  <p>%s</p>
  <div class="grid">
    <table><thead><tr><th>Сифон</th><th>Позиции</th><th>Содержит ловушку</th></tr></thead><tbody>%s</tbody></table>
    <table><thead><tr><th>Ловушка</th><th>Позиции</th></tr></thead><tbody>%s</tbody></table>
  </div>
</body>
</html>]],
        short_res,
        #siphon_rows > 0 and siphon_rows or "<tr><td colspan='3'>Нет</td></tr>",
        #trap_rows > 0 and trap_rows or "<tr><td colspan='2'>Нет</td></tr>"
    )

    return { short_result = short_res, html_report = html }
end

