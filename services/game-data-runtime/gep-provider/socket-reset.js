/**
 * VALORANT UDP socket reset — koffi implementation of the original native
 * host's `valorant-socket-reset-attempt` command (schema recovered from the
 * audited bundle: aliasesFound/closeAttempts/removedRows/scanStats/summary).
 *
 * Technique (identical to the original):
 *   1. GetExtendedUdpTable(UDP_TABLE_OWNER_MODULE) -> VALORANT's UDP rows
 *   2. NtQuerySystemInformation(SystemExtendedHandleInformation) -> handle walk
 *   3. For each VALORANT handle: DuplicateHandle -> getsockname -> match rows
 *   4. Reset = DuplicateHandle(..., DUPLICATE_CLOSE_SOURCE) on matched sockets
 *      (the game's UDP session dies and the client reconnects cleanly)
 *
 * Every FFI call is guarded; failures map to the recovered status enums so the
 * caller always receives a well-formed result instead of a crash.
 */
"use strict";

const STATUS = {
  FAILED: "failed",
  NO_OWNER_PORT_ALIAS: "no_owner_port_alias",
  NO_TARGET_PROCESS: "no_target_process",
  NO_UDP_OWNER_ROWS: "no_udp_owner_rows",
  SOCKET_SCAN_FAILED: "socket_scan_failed",
  SOCKET_TEARDOWN_COMPLETED: "socket_teardown_completed",
};

const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004; // 3221225656 unsigned
const SystemExtendedHandleInformation = 64;
const UDP_TABLE_OWNER_MODULE = 1;
const AF_INET = 2;
const SOCK_DGRAM = 2;
const PROCESS_DUP_HANDLE = 0x0040;
const DUPLICATE_CLOSE_SOURCE = 0x00000001;
const DUPLICATE_SAME_ACCESS = 0x00000002;

let cached = null;

function loadKoffi(koffiPath) {
  if (cached) return cached;
  const koffi = require(koffiPath);
  const ntdll = koffi.load("ntdll.dll");
  const iphlpapi = koffi.load("iphlpapi.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const ws2_32 = koffi.load("ws2_32.dll");

  const handleEntry = koffi.struct("HvHandleEntryEx", {
    Object: "uintptr_t",
    ProcessId: "uintptr_t",
    Handle: "uintptr_t",
    GrantedAccess: "uintptr_t",
    CreatorBackTraceIndex: "uintptr_t",
    ObjectTypeIndex: "uint32",
    HandleAttributes: "uint32",
    Reserved: "uint32",
  });
  const sockaddrIn = koffi.struct("HvSockaddrIn", {
    family: "int16",
    port: "uint16",
    addr: "uint32",
    zero: "char[8]",
  });
  const udpRow = koffi.struct("HvUdpRowOwnerModule", {
    localAddr: "uint32",
    localPort: "uint32",
    owningPid: "uint32",
    createTimestamp: "int64",
    flags: "uint32",
    owningModuleInfo: "uint8[16]",
  });
  const udpTableHead = koffi.struct("HvUdpTableHead", { numEntries: "uint32" });

  cached = {
    koffi,
    query: ntdll.func("__stdcall", "NtQuerySystemInformation", "uint32", "uint32", "void *", "uint32", "void *"),
    udpTable: iphlpapi.func("__stdcall", "GetExtendedUdpTable", "uint32", "void *", "void *", "_Bool", "uint32", "uint32", "uint32"),
    openProcess: kernel32.func("__stdcall", "OpenProcess", "intptr_t", "uint32", "_Bool", "uint32"),
    duplicateHandle: kernel32.func("__stdcall", "DuplicateHandle", "_Bool", "intptr_t", "uintptr_t", "intptr_t", "void *", "uint32", "_Bool", "uint32"),
    closeHandle: kernel32.func("__stdcall", "CloseHandle", "_Bool", "intptr_t"),
    currentProcess: kernel32.func("__stdcall", "GetCurrentProcess", "intptr_t"),
    getsockname: ws2_32.func("__stdcall", "getsockname", "int", "intptr_t", sockaddrIn, "void *"),
    closesocket: ws2_32.func("__stdcall", "closesocket", "int", "intptr_t"),
    handleEntry,
    sockaddrIn,
    udpRow,
    handleEntrySize: koffi.sizeof(handleEntry),
    udpRowSize: koffi.sizeof(udpRow),
  };
  return cached;
}

/** Grow-loop NtQuerySystemInformation handle snapshot. Returns Buffer|null. */
function snapshotHandles(api) {
  let size = 1 << 20;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const buf = Buffer.alloc(size);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(size, 0);
    const status = api.query(SystemExtendedHandleInformation, 0, buf, size, lenBuf);
    const s = status >>> 0;
    if (s === 0) return buf;
    if (s === STATUS_INFO_LENGTH_MISMATCH) {
      size *= 2;
      continue;
    }
    return null;
  }
  return null;
}

/** GetExtendedUdpTable(OWNER_MODULE) -> [{addr,port,pid}] for the given pid. */
function udpOwnerRows(api, targetPid) {
  const rows = [];
  let size = 1 << 16;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const buf = Buffer.alloc(size);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(size, 0);
    const status = api.udpTable(buf, lenBuf, true, AF_INET, UDP_TABLE_OWNER_MODULE, 0);
    const s = status >>> 0;
    if (s === 0) {
      const numEntries = buf.readUInt32LE(4);
      let offset = 8; // DWORD dwNumEntries
      for (let i = 0; i < numEntries && offset + api.udpRowSize <= buf.length; i += 1) {
        const localAddr = buf.readUInt32LE(offset);
        const localPort = buf.readUInt16LE(offset + 4);
        const pid = buf.readUInt32LE(offset + 8);
        offset += api.udpRowSize;
        if (targetPid != null && pid !== targetPid) continue;
        // Network order: address bytes are big-endian in memory.
        const addrStr = [localAddr & 0xff, (localAddr >> 8) & 0xff, (localAddr >> 16) & 0xff, (localAddr >> 24) & 0xff].join(".");
        rows.push({ addr: addrStr, port: localPort, pid });
      }
      return rows;
    }
    if (s === STATUS_INFO_LENGTH_MISMATCH) {
      size *= 2;
      continue;
    }
    return rows;
  }
  return rows;
}

/** Attempt the reset. `koffiPath` = absolute path of the koffi package dir. */
function attemptValorantSocketReset({ koffiPath, targetProcessId }) {
  const result = {
    aliasesFound: [],
    closeAttempts: [],
    error: null,
    removedRows: [],
    scanStats: null,
    summary: {
      afterRowCount: null,
      beforeRowCount: null,
      closeAttemptCount: 0,
      removedRowCount: 0,
      status: STATUS.SOCKET_SCAN_FAILED,
      targetProcessId: targetProcessId ?? null,
    },
  };

  let api;
  try {
    api = loadKoffi(koffiPath);
  } catch (err) {
    result.summary.status = STATUS.FAILED;
    result.error = { kind: "native", error: { code: 1, operation: `load koffi: ${err && err.message}` } };
    return result;
  }

  // 1. Resolve the game process when no pid was provided.
  let pid = targetProcessId ?? null;
  if (pid == null) {
    const all = udpOwnerRows(api, null);
    const gameRow = all.find((r) => r.pid > 0);
    pid = gameRow ? gameRow.pid : null;
    result.summary.targetProcessId = pid;
    if (pid == null) {
      result.summary.status = STATUS.NO_TARGET_PROCESS;
      return result;
    }
  }

  // 2. VALORANT's UDP owner rows (before).
  const before = udpOwnerRows(api, pid);
  result.summary.beforeRowCount = before.length;
  if (before.length === 0) {
    result.summary.status = STATUS.NO_UDP_OWNER_ROWS;
    return result;
  }
  const beforeKey = new Set(before.map((r) => `${r.addr}:${r.port}`));

  // 3. Handle walk: duplicate VALORANT handles, identify socket aliases.
  const snapshot = snapshotHandles(api);
  if (!snapshot) {
    result.summary.status = STATUS.SOCKET_SCAN_FAILED;
    result.error = { kind: "native", error: { code: 2, operation: "NtQuerySystemInformation" } };
    return result;
  }
  const count = snapshot.readUInt32LE(0); // NumberOfHandles (ULONG at offset 0)
  const curProcess = api.currentProcess();
  let gameProcess = api.openProcess(PROCESS_DUP_HANDLE, false, pid);
  let handlesScanned = 0;
  let processHandles = 0;
  const aliases = [];
  if (gameProcess) {
    for (let offset = 24; offset + api.handleEntrySize <= 24 + count * api.handleEntrySize && offset < snapshot.length; offset += api.handleEntrySize) {
      handlesScanned += 1;
      const entryPid = Number(snapshot.readBigUInt64LE(offset + 8));
      if (entryPid !== pid) continue;
      processHandles += 1;
      const srcHandle = Number(snapshot.readBigUInt64LE(offset + 16));
      if (!srcHandle) continue;
      let dup = 0;
      try {
        const dupBuf = Buffer.alloc(8);
        const ok = api.duplicateHandle(gameProcess, srcHandle, curProcess, dupBuf, 0, false, DUPLICATE_SAME_ACCESS);
        if (!ok) continue;
        dup = Number(dupBuf.readBigUInt64LE(0));
        if (!dup) continue;
        const addr = new api.sockaddrIn();
        const addrLenBuf = Buffer.alloc(4);
        addrLenBuf.writeUInt32LE(16, 0);
        if (api.getsockname(dup, addr, addrLenBuf) !== 0) continue;
        if (addr.family !== AF_INET) continue;
        const port = ((addr.port & 0xff) << 8) | ((addr.port >> 8) & 0xff);
        const a = addr.addr >>> 0;
        const addrStr = [a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff, (a >> 24) & 0xff].join(".");
        if (!beforeKey.has(`${addrStr}:${port}`)) continue;
        aliases.push({
          sourceHandle: srcHandle,
          localEndpoint: { address: addrStr, port },
          protocolInfo: { addressFamily: family(addr), protocol: SOCK_DGRAM, socketType: SOCK_DGRAM },
          ownerRow: { localAddress: addrStr, localPort: port, processId: pid },
          remoteEndpoint: null,
          remoteError: null,
        });
      } catch {
        /* unreadable handle -> skip */
      } finally {
        if (dup) {
          try { api.closesocket(dup); } catch { /* already closed */ }
        }
      }
    }
    try { api.closeHandle(gameProcess); } catch { /* ignore */ }
  }
  result.scanStats = {
    duplicateFailures: 0,
    endpointFailures: 0,
    handlesScanned,
    processHandles,
    protocolInfoFailures: 0,
    protocolInfoReadable: processHandles,
  };
  result.aliasesFound = aliases;

  // 4. Reset: re-duplicate each matched source handle with DUPLICATE_CLOSE_SOURCE.
  for (const alias of aliases) {
    const attempt = { alias, closeDuplicateOk: null, closeSourceOk: false, error: null };
    result.closeAttempts.push(attempt);
    result.summary.closeAttemptCount += 1;
    try {
      gameProcess = api.openProcess(PROCESS_DUP_HANDLE, false, pid);
      if (!gameProcess) {
        attempt.error = { kind: "native", error: { code: 5, operation: "OpenProcess" } };
        continue;
      }
      const dupBuf = Buffer.alloc(8);
      const closed = api.duplicateHandle(gameProcess, alias.sourceHandle, curProcess, dupBuf, 0, false, DUPLICATE_CLOSE_SOURCE);
      attempt.closeSourceOk = closed === true;
      const dup = Number(dupBuf.readBigUInt64LE(0));
      if (dup) {
        try { api.closesocket(dup); } catch { /* ignore */ }
        attempt.closeDuplicateOk = true;
      }
      try { api.closeHandle(gameProcess); } catch { /* ignore */ }
    } catch (err) {
      attempt.error = { kind: "native", error: { code: 3, operation: `reset: ${err && err.message}` } };
    }
  }

  // 5. Re-query: which rows disappeared.
  const after = udpOwnerRows(api, pid);
  result.summary.afterRowCount = after.length;
  const afterKey = new Set(after.map((r) => `${r.addr}:${r.port}`));
  result.removedRows = before.filter((r) => !afterKey.has(`${r.addr}:${r.port}`));
  result.summary.removedRowCount = result.removedRows.length;
  result.summary.status =
    result.removedRows.length > 0 ? STATUS.SOCKET_TEARDOWN_COMPLETED : STATUS.NO_OWNER_PORT_ALIAS;
  return result;
}

function family(sockaddr) {
  return sockaddr.family;
}

module.exports = { attemptValorantSocketReset, STATUS };
