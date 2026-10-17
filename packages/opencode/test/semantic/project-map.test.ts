import { describe, expect, test } from "bun:test"
import * as Client from "@/semantic/client"
import * as Protocol from "@/semantic/protocol"
import { renderProjectMap } from "@/semantic/render"
import { frame, listenServer } from "./fake-server"
import {
  SAMPLE_PROJECT_MAP_BUILDING,
  SAMPLE_PROJECT_MAP_BUILDING_RENDER,
  SAMPLE_PROJECT_MAP_DEPENDENCIES,
  SAMPLE_PROJECT_MAP_DEPENDENCIES_RENDER,
  SAMPLE_PROJECT_MAP_HOT,
  SAMPLE_PROJECT_MAP_HOT_RENDER,
  SAMPLE_PROJECT_MAP_STRUCTURE,
  SAMPLE_PROJECT_MAP_STRUCTURE_RENDER,
} from "./fixture"

const decode = (value: unknown) => Protocol.decodeOption(Protocol.ProjectMapResult, value)

describe("semantic project_map render", () => {
  test("renders the spec structure sample byte for byte, including alignment", () => {
    expect(renderProjectMap(SAMPLE_PROJECT_MAP_STRUCTURE)).toBe(SAMPLE_PROJECT_MAP_STRUCTURE_RENDER)
  })

  test("renders the spec dependencies sample byte for byte", () => {
    expect(renderProjectMap(SAMPLE_PROJECT_MAP_DEPENDENCIES)).toBe(SAMPLE_PROJECT_MAP_DEPENDENCIES_RENDER)
  })

  test("renders the hot sample with the file column aligned to the longest listed file", () => {
    expect(renderProjectMap(SAMPLE_PROJECT_MAP_HOT)).toBe(SAMPLE_PROJECT_MAP_HOT_RENDER)
  })

  test("renders a building map as a single rounded progress line", () => {
    expect(renderProjectMap(SAMPLE_PROJECT_MAP_BUILDING)).toBe(SAMPLE_PROJECT_MAP_BUILDING_RENDER)
    expect(renderProjectMap({ ...SAMPLE_PROJECT_MAP_STRUCTURE, building: true, progress: 0.995 })).toBe(
      "project_map building 100%",
    )
    expect(renderProjectMap({ ...SAMPLE_PROJECT_MAP_HOT, building: true })).toBe("project_map building 0%")
  })

  test("truncates modules beyond 20 and aligns on the listed subset only", () => {
    const listed = Array.from({ length: 20 }, (_, index) => ({
      name: `m${index}`,
      path: `m${index}`,
      files: [`f${index}.ts`],
      is_entry: false,
      hot: index === 0,
    }))
    const result: Protocol.ProjectMapStructure = {
      project: { root: "/p", total_files: 21, total_modules: 21 },
      modules: [
        ...listed,
        { name: "extra", path: "very-long-hidden-module-path", files: ["x.ts"], is_entry: false, hot: false },
      ],
      entry_points: [],
      root_files: ["main.py"],
    }

    const lines = renderProjectMap(result).split("\n")
    expect(lines[0]).toBe("project: 21 modules, 21 files")
    expect(lines[1]).toBe("  m0/       [f0.ts]  hot")
    expect(lines[20]).toBe("  m19/      [f19.ts]")
    expect(lines[21]).toBe("  (+1 more modules)")
    expect(lines[22]).toBe("  root:     [main.py]")
    expect(lines[23]).toBe("")
    expect(lines[24]).toBe("entry: none")
    expect(lines).toHaveLength(25)
    expect(renderProjectMap(result)).not.toContain("very-long-hidden-module-path")
  })

  test("renders an empty structure map", () => {
    const result: Protocol.ProjectMapStructure = {
      project: { root: "/p", total_files: 0, total_modules: 0 },
      modules: [],
      entry_points: [],
      root_files: [],
    }

    expect(renderProjectMap(result).split("\n")).toEqual([
      "project: 0 modules, 0 files",
      "  root:     []",
      "",
      "entry: none",
    ])
  })

  test("renders an empty dependency graph and cycle lists", () => {
    const empty: Protocol.ProjectMapDependencies = {
      project: { root: "/p", total_files: 0 },
      dependencies: [],
      cycles: [],
    }
    expect(renderProjectMap(empty)).toBe(["dependencies:", "  (none)", "  cycles: none"].join("\n"))

    const withCycles: Protocol.ProjectMapDependencies = {
      ...empty,
      dependencies: [
        { from: "b", to: "a", count: 2 },
        { from: "b", to: "c", count: 2 },
        { from: "a", to: "x", count: 1 },
      ],
      cycles: [
        ["a", "b"],
        ["c", "d"],
      ],
    }
    expect(renderProjectMap(withCycles)).toBe(
      ["dependencies:", "  a → x (1)", "  b → a (2), c (2)", "  cycles: a → b → a; c → d → c"].join("\n"),
    )
  })

  test("renders the empty hot fallbacks", () => {
    const empty: Protocol.ProjectMapHot = {
      project: { root: "/p", total_files: 0 },
      hot_files: [],
      hot_modules: [],
    }
    expect(renderProjectMap(empty)).toBe("project_map hot: empty (no access stats yet)")

    const noModules: Protocol.ProjectMapHot = {
      ...empty,
      hot_files: [{ file: "a.ts", read_count: 1, edit_count: 1, last_access: "t" }],
    }
    expect(renderProjectMap(noModules).split("\n")[1]).toBe("  a.ts  1 reads, 1 edits")
    expect(renderProjectMap(noModules).split("\n").at(-1)).toBe("hot modules: none")
  })
})

describe("semantic project_map decoding", () => {
  test("accepts the three sample results and a building result", () => {
    expect(decode(SAMPLE_PROJECT_MAP_STRUCTURE)).toEqual(SAMPLE_PROJECT_MAP_STRUCTURE)
    expect(decode(SAMPLE_PROJECT_MAP_DEPENDENCIES)).toEqual(SAMPLE_PROJECT_MAP_DEPENDENCIES)
    expect(decode(SAMPLE_PROJECT_MAP_HOT)).toEqual(SAMPLE_PROJECT_MAP_HOT)
    expect(decode(SAMPLE_PROJECT_MAP_BUILDING)).toEqual(SAMPLE_PROJECT_MAP_BUILDING)
  })

  test("rejects excess fields at the top level and in nested objects", () => {
    const cases = [
      { ...SAMPLE_PROJECT_MAP_STRUCTURE, extra: true },
      { ...SAMPLE_PROJECT_MAP_STRUCTURE, project: { ...SAMPLE_PROJECT_MAP_STRUCTURE.project, extra: 1 } },
      { ...SAMPLE_PROJECT_MAP_STRUCTURE, modules: [{ ...SAMPLE_PROJECT_MAP_STRUCTURE.modules[0], extra: true }] },
      {
        ...SAMPLE_PROJECT_MAP_STRUCTURE,
        entry_points: [{ ...SAMPLE_PROJECT_MAP_STRUCTURE.entry_points[0], extra: 1 }],
      },
      { ...SAMPLE_PROJECT_MAP_DEPENDENCIES, extra: 1 },
      { ...SAMPLE_PROJECT_MAP_DEPENDENCIES, project: { ...SAMPLE_PROJECT_MAP_DEPENDENCIES.project, total_modules: 1 } },
      {
        ...SAMPLE_PROJECT_MAP_DEPENDENCIES,
        dependencies: [{ ...SAMPLE_PROJECT_MAP_DEPENDENCIES.dependencies[0], extra: true }],
      },
      { ...SAMPLE_PROJECT_MAP_HOT, extra: true },
      { ...SAMPLE_PROJECT_MAP_HOT, hot_files: [{ ...SAMPLE_PROJECT_MAP_HOT.hot_files[0], extra: 1 }] },
    ]

    for (const value of cases) expect(decode(value)).toBeUndefined()
  })

  test("rejects mixed shapes instead of picking a partial branch", () => {
    const cases = [
      { ...SAMPLE_PROJECT_MAP_STRUCTURE, dependencies: [], cycles: [] },
      { ...SAMPLE_PROJECT_MAP_DEPENDENCIES, hot_files: [], hot_modules: [] },
      { ...SAMPLE_PROJECT_MAP_HOT, modules: [] },
      { ...SAMPLE_PROJECT_MAP_HOT, entry_points: [], root_files: [] },
      { ...SAMPLE_PROJECT_MAP_DEPENDENCIES, modules: [], total_modules: 1 },
    ]

    for (const value of cases) expect(decode(value)).toBeUndefined()
  })

  test("rejects invalid progress values and non-true building flags", () => {
    expect(decode({ ...SAMPLE_PROJECT_MAP_BUILDING, progress: 1.5 })).toBeUndefined()
    expect(decode({ ...SAMPLE_PROJECT_MAP_BUILDING, progress: -0.1 })).toBeUndefined()
    expect(decode({ ...SAMPLE_PROJECT_MAP_STRUCTURE, building: false })).toBeUndefined()
  })

  test("rejects wrong field types", () => {
    const structure = {
      ...SAMPLE_PROJECT_MAP_STRUCTURE,
      project: { root: "/p", total_files: "47", total_modules: 6 },
    }
    expect(decode(structure)).toBeUndefined()
    const dependencies = {
      ...SAMPLE_PROJECT_MAP_DEPENDENCIES,
      dependencies: [{ from: "a", to: "b", count: "1" }],
    }
    expect(decode(dependencies)).toBeUndefined()
  })
})

describe("semantic project_map client", () => {
  test("decodes each view and forwards the request", async () => {
    const requests: any[] = []
    const results = [SAMPLE_PROJECT_MAP_STRUCTURE, SAMPLE_PROJECT_MAP_DEPENDENCIES, SAMPLE_PROJECT_MAP_HOT]
    const server = await listenServer((message, socket) => {
      if (message.method !== "project_map") return
      requests.push(message)
      socket.write(frame({ jsonrpc: "2.0", id: message.id, result: results[requests.length - 1] }))
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    expect(await client.projectMap({ view: "structure", scope: "module:core" })).toEqual(SAMPLE_PROJECT_MAP_STRUCTURE)
    expect(await client.projectMap({ view: "dependencies" })).toEqual(SAMPLE_PROJECT_MAP_DEPENDENCIES)
    expect(await client.projectMap({})).toEqual(SAMPLE_PROJECT_MAP_HOT)

    expect(requests.every((message) => message.method === "project_map")).toBe(true)
    expect(requests[0]?.params).toEqual({ view: "structure", scope: "module:core" })
    expect(requests[1]?.params).toEqual({ view: "dependencies" })
    expect(requests[2]?.params).toEqual({})

    client.close()
    await server.close()
  })

  test("rejects malformed results instead of silently ignoring fields", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method !== "project_map") return
      socket.write(frame({ jsonrpc: "2.0", id: message.id, result: { ...SAMPLE_PROJECT_MAP_HOT, extra: true } }))
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const error = await client.projectMap({ view: "hot" }).catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error.code).toBe(Protocol.ErrorCode.internalError)
    expect(error.message).toBe("malformed project_map response")

    client.close()
    await server.close()
  })

  test("maps indexing responses to RpcError -32000", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method !== "project_map") return
      socket.write(
        frame({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "indexing", data: { progress: 0.3 } } }),
      )
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const error = await client.projectMap({}).catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error.code).toBe(Protocol.ErrorCode.indexing)

    client.close()
    await server.close()
  })

  test("maps parameter errors to RpcError -32603", async () => {
    const server = await listenServer((message, socket) => {
      if (message.method !== "project_map") return
      socket.write(frame({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "unknown view" } }))
    })
    const client = await Client.connect(server.endpoint, { connect_timeout_ms: 2_000 })

    const error = await client.projectMap({ view: "hot" }).catch((cause) => cause)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error.code).toBe(Protocol.ErrorCode.internalError)

    client.close()
    await server.close()
  })
})
