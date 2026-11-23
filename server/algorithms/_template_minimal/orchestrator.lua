function main(ctx)
    local x = 10

    -- Отправляем один чанк на воркер и ждем результат
    local results = coroutine.yield({
        chunks = {
            {
                tag = "main_step",
                data = { x = 10 },
                max_execution_ms = ctx.config.max_execution_ms or 5000
            }
        }
    })

    local res = results[1]
    if not res or res.status ~= "ok" then
        return { error = "Ошибка воркера: " .. (res and res.errorMessage or "unknown") }
    end

    local out = ctx.json_decode(res.output) or {}
    local summary = string.format("Результат для X = %d равен %d", x, out.result or 0)

    return {
        short_result = summary,
        html_report = string.format("<h1>%s</h1><p>Задача: %s</p>", summary, ctx.task_id)
    }
end

