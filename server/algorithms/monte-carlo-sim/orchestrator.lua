function main(ctx)
    local transitions = ctx.params.transitions
    local initial_marking = ctx.params.initial_marking or {}

    if not transitions or type(transitions) ~= "table" or #transitions == 0 then
        return { error = "Не заданы переходы сети Петри." }
    end

    local total_runs = math.max(1, tonumber(ctx.params.total_runs) or 5000)
    local max_steps = math.max(1, tonumber(ctx.params.max_steps) or 500)
    local num_chunks = math.max(1, math.min(64, tonumber(ctx.params.parallel_chunks) or 8))
    if num_chunks > total_runs then num_chunks = total_runs end

    local max_retries = tonumber(ctx.config.max_retries) or 2
    local timeout_ms = tonumber(ctx.config.max_execution_ms) or 15000

    -- Распределяем прогоны по независимым батчам для воркеров
    local base_runs = math.floor(total_runs / num_chunks)
    local remainder = total_runs % num_chunks

    local pending = {}
    for i = 1, num_chunks do
        local runs_for_chunk = base_runs + (i <= remainder and 1 or 0)
        pending[i] = {
            id = "mc_batch_" .. i,
            runs = runs_for_chunk,
            seed = 100000 + i * 7919,
            done = false,
            data = nil
        }
    end

    -- Волна Map: параллельный запуск на кластере
    for attempt = 1, max_retries + 1 do
        local batch = {}
        for i = 1, num_chunks do
            if not pending[i].done then
                table.insert(batch, {
                    tag = pending[i].id,
                    data = {
                        transitions = transitions,
                        initial_marking = initial_marking,
                        runs = pending[i].runs,
                        max_steps = max_steps,
                        seed = pending[i].seed,
                        record_trace = (i == 1) -- Подробную трассу пишем только с 1-го батча
                    },
                    max_execution_ms = timeout_ms
                })
            end
        end

        if #batch == 0 then break end

        local results = coroutine.yield({ chunks = batch })
        for _, res in ipairs(results) do
            if res.status == "ok" then
                local idx = tonumber(string.match(res.tag, "mc_batch_(%d+)"))
                if idx and pending[idx] then
                    pending[idx].done = true
                    pending[idx].data = ctx.json_decode(res.output)
                end
            elseif res.errorType == "SyntaxError" or res.errorType == "FatalAlgorithmError" then
                return { error = "Ошибка в скрипте воркера: " .. (res.errorMessage or "") }
            end
        end
    end

    -- Проверка, что все батчи собраны
    for i = 1, num_chunks do
        if not pending[i].done or not pending[i].data then
            return { error = "Не удалось завершить все параллельные батчи симуляции." }
        end
    end

    -- Reduce: агрегация статистики со всех воркеров
    local places = pending[1].data.places or {}
    local t_names = pending[1].data.t_names or {}
    local num_p = #places
    local num_t = #t_names

    local agg_runs = 0
    local agg_deadlocks = 0
    local agg_total_steps = 0
    local agg_t_firings = {}
    local agg_p_sum = {}
    local agg_p_max = {}
    local agg_step_hist = {} -- 10 корзин для гистограммы шагов до тупика

    for i = 1, num_t do agg_t_firings[i] = 0 end
    for i = 1, num_p do agg_p_sum[i] = 0; agg_p_max[i] = 0 end
    for b = 1, 10 do agg_step_hist[b] = 0 end

    local sample_trace = nil
    local sample_trace_deadlock = false

    for i = 1, num_chunks do
        local d = pending[i].data
        agg_runs = agg_runs + (d.runs or 0)
        agg_deadlocks = agg_deadlocks + (d.deadlocks or 0)
        agg_total_steps = agg_total_steps + (d.total_steps or 0)

        for t_i = 1, num_t do
            agg_t_firings[t_i] = agg_t_firings[t_i] + (d.t_firings[t_i] or 0)
        end
        for p_i = 1, num_p do
            agg_p_sum[p_i] = agg_p_sum[p_i] + (d.p_sum[p_i] or 0)
            local m = d.p_max[p_i] or 0
            if m > agg_p_max[p_i] then agg_p_max[p_i] = m end
        end
        for b = 1, 10 do
            agg_step_hist[b] = agg_step_hist[b] + (d.step_hist[b] or 0)
        end
        if d.trace and #d.trace > 0 then
            sample_trace = d.trace
            sample_trace_deadlock = d.trace_is_deadlock
        end
    end
    local deadlock_pct = (agg_runs > 0) and (agg_deadlocks * 100.0 / agg_runs) or 0.0
    local avg_steps = (agg_runs > 0) and (agg_total_steps / agg_runs) or 0.0

    local short_res = string.format(
        "Прогонов: %d | Тупиков: %d (%.2f%%) | Ср. длина прогона: %.1f шагов.",
        agg_runs, agg_deadlocks, deadlock_pct, avg_steps
    )

    -- Генерация SVG-графика распределения шагов до тупика
    local max_hist = 1
    for b = 1, 10 do
        if agg_step_hist[b] > max_hist then max_hist = agg_step_hist[b] end
    end

    local svg_bars = ""
    local bucket_size = math.max(1, math.ceil(max_steps / 10))
    for b = 1, 10 do
        local val = agg_step_hist[b]
        local bar_h = math.floor((val / max_hist) * 110)
        local x = (b - 1) * 58 + 20
        local y = 130 - bar_h
        local range_lbl = string.format("%d-%d", (b - 1) * bucket_size + 1, math.min(max_steps, b * bucket_size))
        svg_bars = svg_bars .. string.format([[
            <rect x="%d" y="%d" width="42" height="%d" fill="#e05a47" rx="3"/>
            <text x="%d" y="%d" font-size="10" text-anchor="middle" fill="#333">%d</text>
            <text x="%d" y="146" font-size="9" text-anchor="middle" fill="#666">%s</text>
        ]], x, y, bar_h, x + 21, y - 4, val, x + 21, range_lbl)
    end

    local deadlock_chart_html = ""
    if agg_deadlocks > 0 then
        deadlock_chart_html = string.format([[
        <div class="card">
          <h3>Распределение шагов, на которых наступал тупик (Deadlock Histogram)</h3>
          <svg width="610" height="160" style="background:#fafafa; border:1px solid #eee; border-radius:6px;">
            <line x1="10" y1="130" x2="600" y2="130" stroke="#ccc"/>
            %s
          </svg>
        </div>]], svg_bars)
    else
        deadlock_chart_html = [[
        <div class="card" style="border-left: 4px solid #2e7d32;">
          <h3>Тупики не обнаружены</h3>
          <p>За все прогоны сеть ни разу не зашла в тупиковое состояние в пределах лимита шагов.</p>
        </div>]]
    end

    -- Таблица и прогресс-бары по переходам
    local max_t_fire = 1
    for i = 1, num_t do
        if agg_t_firings[i] > max_t_fire then max_t_fire = agg_t_firings[i] end
    end

    local t_rows = ""
    for i = 1, num_t do
        local cnt = agg_t_firings[i]
        local pct = math.floor((cnt / max_t_fire) * 100)
        local per_run = (agg_runs > 0) and (cnt / agg_runs) or 0
        local status_badge = (cnt == 0) and "<span class='badge warn'>Не сработал ни разу</span>" or ""
        t_rows = t_rows .. string.format([[
        <tr>
          <td><b>%s</b> %s</td>
          <td>%d (%.2f / прогон)</td>
          <td style="width:45%%;">
            <div class="bar-bg"><div class="bar-fill" style="width:%d%%;"></div></div>
          </td>
        </tr>]], t_names[i], status_badge, cnt, per_run, pct)
    end

    -- Таблица по позициям (плотность и ограниченность)
    local p_rows = ""
    for i = 1, num_p do
        local mean_tokens = (agg_total_steps > 0) and (agg_p_sum[i] / agg_total_steps) or 0
        local max_tokens = agg_p_max[i]
        p_rows = p_rows .. string.format(
            "<tr><td><b>%s</b></td><td>%.2f</td><td>%d</td></tr>",
            places[i], mean_tokens, max_tokens
        )
    end

    -- Сворачиваемый лог репрезентативного прогона
    local trace_lines = ""
    if sample_trace then
        for _, line in ipairs(sample_trace) do
            trace_lines = trace_lines .. line .. "\n"
        end
    else
        trace_lines = "Лог не записан."
    end

    local trace_title = sample_trace_deadlock
        and "Пошаговый лог прогона, приведшего к ТУПИКУ (нажмите, чтобы развернуть)"
        or "Пошаговый лог контрольного прогона (нажмите, чтобы развернуть)"

    local html = string.format([[
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Отчет Монте-Карло</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; color: #222; background: #f8f9fa; }
  .kpi-grid { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .kpi { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px 20px; min-width: 170px; }
  .kpi .val { font-size: 24px; font-weight: bold; margin-top: 4px; }
  .kpi .lbl { font-size: 12px; color: #666; text-transform: uppercase; }
  .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; }
  .two-col { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
  table { width: 100%%; border-collapse: collapse; margin-top: 8px; }
  th, td { border-bottom: 1px solid #eee; padding: 8px 10px; text-align: left; font-size: 14px; }
  th { background: #f4f6f8; color: #444; }
  .bar-bg { background: #edf2f7; border-radius: 4px; height: 14px; width: 100%%; overflow: hidden; }
  .bar-fill { background: #3182ce; height: 100%%; }
  .badge.warn { background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: 6px; }
  details { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 16px; }
  summary { cursor: pointer; font-weight: 600; color: #0969da; user-select: none; }
  pre { background: #1e1e1e; color: #d4d4d4; padding: 14px; border-radius: 6px; overflow-x: auto; max-height: 400px; font-size: 13px; line-height: 1.45; margin-top: 12px; }
</style>
</head>
<body>
  <h2>Стохастическая симуляция сети Петри (Монте-Карло)</h2>

  <div class="kpi-grid">
    <div class="kpi"><div class="lbl">Всего прогонов</div><div class="val">%d</div></div>
    <div class="kpi"><div class="lbl">Вероятность тупика</div><div class="val" style="color:%s;">%.2f%% (%d)</div></div>
    <div class="kpi"><div class="lbl">Средняя длина прогона</div><div class="val">%.1f <span style="font-size:14px;font-weight:normal;">шагов</span></div></div>
    <div class="kpi"><div class="lbl">Параллельных воркеров</div><div class="val">%d</div></div>
  </div>

  %s

  <div class="two-col">
    <div class="card" style="flex: 1.4; min-width: 340px;">
      <h3>Активность переходов (Transition Utilization)</h3>
      <table>
        <thead><tr><th>Переход</th><th>Срабатываний</th><th>Относительная частота</th></tr></thead>
        <tbody>%s</tbody>
      </table>
    </div>
    <div class="card" style="flex: 1; min-width: 280px;">
      <h3>Плотность и ограниченность позиций</h3>
      <table>
        <thead><tr><th>Позиция</th><th>Ср. фишек</th><th>Макс. фишек</th></tr></thead>
        <tbody>%s</tbody>
      </table>
    </div>
  </div>

  <details>
    <summary>%s</summary>
    <pre>%s</pre>
  </details>
</body>
</html>]],
        agg_runs,
        agg_deadlocks > 0 and "#d32f2f" or "#2e7d32",
        deadlock_pct, agg_deadlocks,
        avg_steps,
        num_chunks,
        deadlock_chart_html,
        t_rows,
        p_rows,
        trace_title,
        trace_lines
    )

    return { short_result = short_res, html_report = html }
end