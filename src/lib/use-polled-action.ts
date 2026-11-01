import { useEffect, useRef, useState } from "react"
import { useAction } from "convex/react"
import type { FunctionReference, FunctionReturnType } from "convex/server"

/** Runs a Convex action now, then again every `everyMs` while the page is open (and when the tab comes back into
 *  view). Returns `[data, refetch]` — call `refetch()` right after a mutation that should show up immediately
 *  (e.g. dismissing a suggestion), instead of making the person wait for the next poll. */
export function usePolledAction<F extends FunctionReference<"action">>(fn: F, args: F["_args"], everyMs = 60000): [FunctionReturnType<F> | undefined, () => void] {
  const run = useAction(fn)
  const [data, setData] = useState<FunctionReturnType<F> | undefined>(undefined)
  const key = JSON.stringify(args)
  const live = useRef(key)
  const loadRef = useRef<() => void>(() => {})
  useEffect(() => {
    live.current = key
    setData(undefined)
    let stop = false
    const load = async () => {
      if (document.visibilityState === "hidden") return
      try {
        const r = await run(JSON.parse(key))
        if (!stop && live.current === key) setData(r)
      } catch { /* keep old numbers; next tick retries */ }
    }
    loadRef.current = () => void load()
    void load()
    const id = setInterval(load, everyMs)
    const vis = () => document.visibilityState === "visible" && load()
    document.addEventListener("visibilitychange", vis)
    return () => { stop = true; clearInterval(id); document.removeEventListener("visibilitychange", vis) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const refetch = useRef(() => loadRef.current()).current
  return [data, refetch]
}
