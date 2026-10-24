import { useEffect, useRef, useState } from "react"
import { useAction } from "convex/react"
import type { FunctionReference, FunctionReturnType } from "convex/server"

/** Runs a Convex action now, then again every `everyMs` while the page is open (and when the tab comes back into view). */
export function usePolledAction<F extends FunctionReference<"action">>(fn: F, args: F["_args"], everyMs = 60000): FunctionReturnType<F> | undefined {
  const run = useAction(fn)
  const [data, setData] = useState<FunctionReturnType<F> | undefined>(undefined)
  const key = JSON.stringify(args)
  const live = useRef(key)
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
    void load()
    const id = setInterval(load, everyMs)
    const vis = () => document.visibilityState === "visible" && load()
    document.addEventListener("visibilitychange", vis)
    return () => { stop = true; clearInterval(id); document.removeEventListener("visibilitychange", vis) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return data
}
