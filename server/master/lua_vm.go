/**
 * @file lua_bridge.go
 * @brief Мост между Go и Lua VM: песочница, конвертация типов и системное API для оркестратора.
 */
package main

import (
	"encoding/json"

	lua "github.com/yuin/gopher-lua"
)

/**
 * @brief Создает изолированный экземпляр Lua VM с ограниченным набором стандартных библиотек (без io/os).
 */
func newSandboxedLuaState() *lua.LState {
	L := lua.NewState(lua.Options{SkipOpenLibs: true})
	for _, pair := range []struct {
		n string
		f lua.LGFunction
	}{
		{lua.LoadLibName, lua.OpenPackage},
		{lua.BaseLibName, lua.OpenBase},
		{lua.TabLibName, lua.OpenTable},
		{lua.StringLibName, lua.OpenString},
		{lua.MathLibName, lua.OpenMath},
		{lua.CoroutineLibName, lua.OpenCoroutine},
	} {
		L.Push(L.NewFunction(pair.f))
		L.Push(lua.LString(pair.n))
		L.Call(1, 0)
	}
	// Опционально блокируем небезопасные глобальные функции
	// L.SetGlobal("dofile", lua.LNil)
	// L.SetGlobal("loadfile", lua.LNil)
	// L.SetGlobal("require", lua.LNil)
	return L
}

/**
 * @brief Рекурсивно конвертирует значение из Go в тип данных Lua (lua.LValue).
 */
func goToLua(L *lua.LState, val any) lua.LValue {
	if val == nil {
		return lua.LNil
	}
	switch v := val.(type) {
	case bool:
		return lua.LBool(v)
	case float64:
		return lua.LNumber(v)
	case int:
		return lua.LNumber(v)
	case string:
		return lua.LString(v)
	case []any:
		tbl := L.NewTable()
		for i, item := range v {
			tbl.RawSetInt(i+1, goToLua(L, item))
		}
		return tbl
	case map[string]any:
		tbl := L.NewTable()
		for k, item := range v {
			tbl.RawSetString(k, goToLua(L, item))
		}
		return tbl
	default:
		b, _ := json.Marshal(v)
		var generic any
		if json.Unmarshal(b, &generic) == nil {
			return goToLua(L, generic)
		}
		return lua.LString(string(b))
	}
}

/**
 * @brief Рекурсивно конвертирует значение из Lua в нативный тип Go (срез, мапу или примитив).
 */
func luaToGo(lv lua.LValue) any {
	switch v := lv.(type) {
	case *lua.LNilType:
		return nil
	case lua.LBool:
		return bool(v)
	case lua.LNumber:
		return float64(v)
	case lua.LString:
		return string(v)
	case *lua.LTable:
		if maxN := v.MaxN(); maxN > 0 {
			arr := make([]any, 0, maxN)
			for i := 1; i <= maxN; i++ {
				arr = append(arr, luaToGo(v.RawGetInt(i)))
			}
			return arr
		}
		m := make(map[string]any)
		v.ForEach(func(k, val lua.LValue) { m[k.String()] = luaToGo(val) })
		return m
	default:
		return lv.String()
	}
}

/**
 * @brief Формирует таблицу контекста (ctx) с параметрами задачи и системными функциями для Lua.
 * @param L Экземпляр Lua VM.
 * @param t Активная задача.
 */
func (mc *MasterCluster) buildLuaContext(L *lua.LState, t *Task) *lua.LTable {
	ctx := L.NewTable()
	ctx.RawSetString("task_id", lua.LString(t.ID))
	ctx.RawSetString("params", goToLua(L, t.Params))
	ctx.RawSetString("config", goToLua(L, t.AlgoPkg.Meta.Config))

	// ctx.strike_worker(workerId) -> увеличивает страйк и банит при превышении глобального лимита
	ctx.RawSetString("strike_worker", L.NewFunction(func(L *lua.LState) int {
		wID := L.CheckString(1)
		mc.mu.Lock()
		defer mc.mu.Unlock()
		if w, ok := mc.workers[wID]; ok {
			w.Strikes++
			if MaxStrikesBeforeBan > 0 && w.Strikes >= MaxStrikesBeforeBan {
				w.Banned = true
			}
			L.Push(lua.LBool(w.Banned))
			return 1
		}
		L.Push(lua.LFalse)
		return 1
	}))

	// ctx.json_encode(table) -> JSON-строка
	ctx.RawSetString("json_encode", L.NewFunction(func(L *lua.LState) int {
		b, _ := json.Marshal(luaToGo(L.CheckAny(1)))
		L.Push(lua.LString(string(b)))
		return 1
	}))

	// ctx.json_decode(str) -> таблица Lua или nil
	ctx.RawSetString("json_decode", L.NewFunction(func(L *lua.LState) int {
		var out any
		if err := json.Unmarshal([]byte(L.CheckString(1)), &out); err != nil {
			L.Push(lua.LNil)
			return 1
		}
		L.Push(goToLua(L, out))
		return 1
	}))

	return ctx
}
