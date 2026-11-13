import { useCallback, useEffect, useRef, useState } from 'react';

export type Kind = 'wan' | 'firewall' | 'core' | 'switch' | 'ap' | 'camera' | 'nas' | 'home' | 'server';
export type Device = {
  id: string;
  name: string;
  ip: string;
  kind: Kind;
  parent_id: string | null;
  status: 'online' | 'warning' | 'offline' | 'unknown' | 'unconfigured';
  down_bps: number | null;
  up_bps: number | null;
  traffic_history?: (number | null)[];
  uplink?: { index: number; name: string | null; capacity_bps?: number | null } | null;
  host: { uptime_seconds?: number | null; cpu_percent: number | null; ram_percent: number | null } | null;
};

export type Snapshot = {
  updated_at: string;
  mock: boolean;
  devices: Device[];
  summary: {
    ports_up: number;
    ports_total: number;
    down_bps: number | null;
    up_bps: number | null;
    speedtest: { ping_ms: number; down_bps: number; up_bps: number } | null;
  };
};

export function rate(bps: number | null | undefined, compact = false): string {
  if (bps == null) return '—';
  const unit = bps >= 1e6 ? 'Mbps' : 'Kbps';
  return `${(bps / (unit === 'Mbps' ? 1e6 : 1e3)).toFixed(compact ? 0 : 1)} ${unit}`;
}

export function useTopology() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef<AbortController | null>(null);

  const accept = useCallback((next: Snapshot) => {
    setSnapshot(previous => !previous || Date.parse(next.updated_at) >= Date.parse(previous.updated_at) ? next : previous);
    setError(false);
  }, []);

  const refresh = useCallback(async () => {
    active.current?.abort();
    const request = new AbortController();
    active.current = request;
    const timeout = window.setTimeout(() => request.abort(), 5000);
    try {
      const response = await fetch('/api/topology', { signal: request.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json() as Snapshot;
      if (active.current === request) accept(data);
    } catch {
      if (active.current === request) setError(true);
    } finally {
      window.clearTimeout(timeout);
    }
  }, [accept]);

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let socket: WebSocket;
    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/ws/topology`);
      socket.onmessage = event => {
        if (stopped) return;
        accept(JSON.parse(event.data) as Snapshot);
        setConnected(true);
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnected(false);
        void refresh();
        retry = window.setTimeout(connect, 3000);
      };
    }
    void refresh();
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      socket.close();
      const request = active.current;
      active.current = null;
      request?.abort();
    };
  }, [accept, refresh]);

  return { snapshot, connected, error, refresh };
}
