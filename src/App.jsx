import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import * as d3 from "d3";
import * as XLSX from "xlsx";
import {
  Sprout, Plus, Trash2,
  BarChart3, ClipboardList, MapPin, Calendar, Clock,
  ChevronRight, Settings2, Loader2, UploadCloud, LogOut, Lock, Users, Circle,
  ZoomIn, ZoomOut, Maximize2, Download, WifiOff, RefreshCw,
  Sprout as SproutIcon
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from "recharts";
import { supabase } from "./supabaseClient";

const FALLBACK_OP_META = { label: "Operação", color: "#8A7F6A", icon: Circle };
const CUSTOM_OP_COLORS = ["#9C4F96", "#A9784B", "#4E6C9C", "#B0793E", "#7C4C6C", "#D14B6A", "#5C5C99", "#2E5FA3", "#C9622E", "#C9A227"];
function buildOpMeta(opTypesRows) {
  const merged = {};
  (opTypesRows || []).forEach(r => {
    merged[r.key] = { label: r.label, color: r.color, icon: Circle };
  });
  return merged;
}
const SOIL_BARE = "#7C6A4F";
const UNIDADES = ["sc", "kg", "ton", "cx", "L"];

const ROLE_META = {
  gestor: { label: "Administrador", color: "#C9A227" },
  operador: { label: "Operador", color: "#4F7942" },
  supervisor: { label: "Supervisor", color: "#3E7C8C" },
};
const TABS_BY_ROLE = {
  gestor: [
    { id: "painel", label: "Painel", icon: BarChart3 },
    { id: "historico", label: "Histórico", icon: ClipboardList },
    { id: "cadastro", label: "Cadastro", icon: Settings2 },
  ],
  operador: [
    { id: "painel", label: "Painel", icon: BarChart3 },
    { id: "lancamento", label: "Lançamento", icon: Plus },
    { id: "historico", label: "Histórico", icon: ClipboardList },
  ],
  supervisor: [
    { id: "painel", label: "Painel", icon: BarChart3 },
  ],
};

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmtDateBR(iso) { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("pt-BR", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
function hexA(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function fieldProgress(field, ops, opMeta) {
  if (!ops.length) return { last: null, meta: null, pct: 0 };
  const sorted = [...ops].sort((a, b) => (a.date < b.date ? 1 : -1));
  const last = sorted[0];
  const meta = opMeta[last.op_type] || FALLBACK_OP_META;
  const sameType = ops.filter(o => o.op_type === last.op_type);
  const worked = sameType.reduce((s, o) => s + (Number(o.area_worked) || 0), 0);
  const pct = field.area_ha > 0 ? Math.min(100, (worked / field.area_ha) * 100) : 0;
  return { last, meta, pct };
}
function usernameToEmail(username) { return `${String(username).trim().toLowerCase()}@fieldbook.local`; }
function useIsDesktop(breakpoint = 768) {
  const [isDesktop, setIsDesktop] = useState(() => (typeof window !== "undefined" ? window.innerWidth >= breakpoint : true));
  useEffect(() => {
    function onResize() { setIsDesktop(window.innerWidth >= breakpoint); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isDesktop;
}

/* --------- KML --------- */
function parseKML(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.getElementsByTagName("parsererror").length) return [];
  const placemarks = Array.from(doc.getElementsByTagName("Placemark"));
  const results = [];
  placemarks.forEach((pm, idx) => {
    const nameNode = pm.getElementsByTagName("name")[0];
    const baseName = nameNode && nameNode.textContent.trim() ? nameNode.textContent.trim() : `Talhão ${idx + 1}`;
    const polygons = Array.from(pm.getElementsByTagName("Polygon"));
    polygons.forEach((poly, pi) => {
      const outer = poly.getElementsByTagName("outerBoundaryIs")[0];
      const coordNode = outer ? outer.getElementsByTagName("coordinates")[0] : null;
      if (!coordNode) return;
      const raw = coordNode.textContent.trim();
      const ring = raw.split(/\s+/).filter(Boolean).map(pair => {
        const parts = pair.split(",");
        return [parseFloat(parts[0]), parseFloat(parts[1])];
      }).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (ring.length >= 3) results.push({ name: polygons.length > 1 ? `${baseName} ${pi + 1}` : baseName, coords: ring });
    });
  });
  return results;
}
function ringAreaHa(ring) {
  const R = 6378137, toRad = Math.PI / 180;
  const latAvg = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = R * toRad * Math.cos(latAvg * toRad), ky = R * toRad;
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[(i + 1) % ring.length];
    area += (lng1 * kx) * (lat2 * ky) - (lng2 * kx) * (lat1 * ky);
  }
  return Math.abs(area / 2) / 10000;
}
function computeBBox(fields) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  fields.forEach(f => {
    (f.coords || []).forEach(([lng, lat]) => {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    });
  });
  if (!Number.isFinite(minLng)) return null;
  const lngPad = Math.max((maxLng - minLng) * 0.1, 0.0004);
  const latPad = Math.max((maxLat - minLat) * 0.1, 0.0004);
  return { minLng: minLng - lngPad, minLat: minLat - latPad, maxLng: maxLng + lngPad, maxLat: maxLat + latPad };
}

/* --------- Offline: cache local + fila de sincronização --------- */
const LS_REF = "fob_ref_cache_v1";
const LS_PENDING = "fob_pending_ops_v1";
function loadRefCache() {
  try { const raw = localStorage.getItem(LS_REF); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function saveRefCache(data) {
  try { localStorage.setItem(LS_REF, JSON.stringify({ ...data, savedAt: Date.now() })); } catch (e) { /* localStorage indisponível ou cheio */ }
}
function loadPendingOps() {
  try { const raw = localStorage.getItem(LS_PENDING); return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
}
function savePendingOps(list) {
  try { localStorage.setItem(LS_PENDING, JSON.stringify(list)); } catch (e) { /* localStorage indisponível ou cheio */ }
}

export default function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [hasAdmin, setHasAdmin] = useState(null);
  const [profile, setProfile] = useState(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [saveError, setSaveError] = useState(null);
  const [usingCache, setUsingCache] = useState(false);
  const [profileTimedOut, setProfileTimedOut] = useState(false);

  const [farms, setFarms] = useState([]);
  const [retiros, setRetiros] = useState([]);
  const [fields, setFields] = useState([]);
  const [machines, setMachines] = useState([]);
  const [opTypesRows, setOpTypesRows] = useState([]);
  const [operations, setOperations] = useState([]);
  const [profiles, setProfiles] = useState([]);

  const [tab, setTab] = useState("painel");

  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [pendingOps, setPendingOps] = useState(() => loadPendingOps());
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, sess) => setSession(sess));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) return; // já logado, não precisa checar
    if (!navigator.onLine) { setHasAdmin(true); return; } // offline: assume que já existe, evita mostrar "primeiro acesso" à toa
    supabase.rpc("has_any_gestor").then(({ data, error }) => setHasAdmin(error ? true : !!data));
  }, [session]);

  useEffect(() => {
    if (!session) { setProfile(null); return; }
    function useCachedProfile() {
      const cache = loadRefCache();
      const cached = (cache?.profiles || []).find(p => p.id === session.user.id);
      if (cached) setProfile(cached);
    }
    if (!navigator.onLine) { useCachedProfile(); return; }
    supabase.from("profiles").select("*").eq("id", session.user.id).single()
      .then(({ data }) => { if (data) setProfile(data); else useCachedProfile(); })
      .catch(() => useCachedProfile());
  }, [session]);

  useEffect(() => {
    if (!session || (profile && !dataLoading)) { setProfileTimedOut(false); return; }
    const t = setTimeout(() => setProfileTimedOut(true), 6000);
    return () => clearTimeout(t);
  }, [session, profile, dataLoading]);

  /* ---------- online/offline ---------- */
  useEffect(() => {
    function onOnline() { setIsOnline(true); }
    function onOffline() { setIsOnline(false); }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, []);

  const fetchAll = useCallback(async () => {
    if (!navigator.onLine) {
      const cache = loadRefCache();
      if (cache) {
        setFarms(cache.farms || []); setRetiros(cache.retiros || []); setFields(cache.fields || []);
        setMachines(cache.machines || []); setOpTypesRows(cache.opTypesRows || []);
        setOperations(cache.operations || []); setProfiles(cache.profiles || []);
        setUsingCache(true);
      }
      setDataLoading(false);
      return;
    }
    try {
      const [f, r, fl, mc, ot, op, pr] = await Promise.all([
        supabase.from("farms").select("*").order("name"),
        supabase.from("retiros").select("*").order("name"),
        supabase.from("fields").select("*").order("name"),
        supabase.from("machines").select("*").order("name"),
        supabase.from("op_types").select("*").order("created_at"),
        supabase.from("operations").select("*").order("date", { ascending: false }),
        supabase.from("profiles").select("*").order("name"),
      ]);
      if (f.error || r.error || fl.error || mc.error || ot.error || op.error || pr.error) throw new Error("network");
      const next = {
        farms: f.data || [], retiros: r.data || [], fields: fl.data || [],
        machines: mc.data || [], opTypesRows: ot.data || [], operations: op.data || [], profiles: pr.data || [],
      };
      setFarms(next.farms); setRetiros(next.retiros); setFields(next.fields);
      setMachines(next.machines); setOpTypesRows(next.opTypesRows);
      setOperations(next.operations); setProfiles(next.profiles);
      setUsingCache(false);
      saveRefCache(next);
    } catch (e) {
      const cache = loadRefCache();
      if (cache) {
        setFarms(cache.farms || []); setRetiros(cache.retiros || []); setFields(cache.fields || []);
        setMachines(cache.machines || []); setOpTypesRows(cache.opTypesRows || []);
        setOperations(cache.operations || []); setProfiles(cache.profiles || []);
        setUsingCache(true);
      }
    }
    setDataLoading(false);
  }, []);

  useEffect(() => {
    if (!profile) return;
    fetchAll();
    if (!navigator.onLine) return;
    const channel = supabase
      .channel("field-ops-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "farms" }, fetchAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "retiros" }, fetchAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "fields" }, fetchAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "machines" }, fetchAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "op_types" }, fetchAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "operations" }, fetchAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, fetchAll)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [profile, fetchAll]);

  useEffect(() => {
    if (!profile) return;
    const allowed = (TABS_BY_ROLE[profile.role] || TABS_BY_ROLE.operador).map(t => t.id);
    if (!allowed.includes(tab)) setTab(allowed[0]);
    // eslint-disable-next-line
  }, [profile && profile.id, profile && profile.role]);

  /* ---------- sincronização de lançamentos pendentes ---------- */
  const syncPending = useCallback(async () => {
    if (syncing) return;
    const list = loadPendingOps();
    if (!list.length || !navigator.onLine) return;
    setSyncing(true);
    const remaining = [];
    for (const rec of list) {
      const { _localId, ...toInsert } = rec;
      const { error } = await supabase.from("operations").insert(toInsert);
      if (error) remaining.push(rec);
    }
    savePendingOps(remaining);
    setPendingOps(remaining);
    setSyncing(false);
    if (remaining.length < list.length) fetchAll();
    // eslint-disable-next-line
  }, [fetchAll]);

  useEffect(() => {
    if (isOnline && pendingOps.length > 0) syncPending();
    // eslint-disable-next-line
  }, [isOnline]);

  /* ---------- auth ---------- */
  async function handleLogin(username, password) {
    if (!navigator.onLine) return "Sem conexão — é preciso internet para fazer login pela primeira vez neste aparelho.";
    const { data: email, error: rpcError } = await supabase.rpc("get_email_by_username", { p_username: username.trim() });
    if (rpcError || !email) return "Usuário ou senha inválidos.";
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return "Usuário ou senha inválidos.";
    return null;
  }
  async function handleFirstRunCreate({ name, username, password }) {
    const email = usernameToEmail(username);
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return error.message;
    const userId = data.user?.id;
    if (!userId) return "Não foi possível criar o usuário. Verifique se 'Confirm email' está desativado no Supabase.";
    const { error: profileError } = await supabase.from("profiles").insert({ id: userId, username: username.trim(), name: name.trim(), role: "gestor" });
    if (profileError) return profileError.message;
    return null;
  }
  async function handleLogout() { await supabase.auth.signOut(); }

  /* ---------- CRUD ---------- */
  async function addFarm(name) {
    const { error } = await supabase.from("farms").insert({ name });
    if (error) setSaveError(error.message); else fetchAll();
  }
  async function removeFarm(id) {
    const { error } = await supabase.from("farms").delete().eq("id", id);
    if (error) setSaveError(error.message); else fetchAll();
  }
  async function addRetiro(farmId, name) {
    const { error } = await supabase.from("retiros").insert({ farm_id: farmId, name });
    if (error) setSaveError(error.message); else fetchAll();
  }
  async function removeRetiro(id) {
    const { error } = await supabase.from("retiros").delete().eq("id", id);
    if (error) setSaveError(error.message); else fetchAll();
  }
  async function removeField(id) {
    const { error } = await supabase.from("fields").delete().eq("id", id);
    if (error) setSaveError(error.message); else fetchAll();
  }
  async function importKml(farmId, retiroId, parsed) {
    let created = 0, updated = 0;
    for (const p of parsed) {
      const areaHa = Math.round(ringAreaHa(p.coords) * 100) / 100;
      const existing = fields.find(f => f.retiro_id === retiroId && f.name.trim().toLowerCase() === p.name.trim().toLowerCase());
      if (existing) {
        const { error } = await supabase.from("fields").update({ coords: p.coords, area_ha: areaHa }).eq("id", existing.id);
        if (!error) updated++;
      } else {
        const { error } = await supabase.from("fields").insert({ farm_id: farmId, retiro_id: retiroId, name: p.name, area_ha: areaHa, coords: p.coords });
        if (!error) created++;
      }
    }
    await fetchAll();
    return { created, updated };
  }
  async function addMachine(name) {
    const { error } = await supabase.from("machines").insert({ name });
    if (error) setSaveError(error.message); else fetchAll();
  }
  async function removeMachine(id) {
    const { error } = await supabase.from("machines").delete().eq("id", id);
    if (error) setSaveError(error.message); else fetchAll();
  }
  async function updateMachineFarm(id, farmId) {
    const { error } = await supabase.from("machines").update({ farm_id: farmId || null }).eq("id", id);
    if (error) setSaveError(error.message); else fetchAll();
  }
  async function addCustomOpType(name) {
    const dup = opTypesRows.some(r => r.label.trim().toLowerCase() === name.trim().toLowerCase());
    if (dup) return "Já existe uma operação com esse nome.";
    const color = CUSTOM_OP_COLORS[opTypesRows.length % CUSTOM_OP_COLORS.length];
    const { error } = await supabase.from("op_types").insert({ key: uid(), label: name.trim(), color, is_builtin: false, enabled: true });
    if (error) return error.message;
    await fetchAll();
    return null;
  }
  async function addOperation(rec) {
    if (!navigator.onLine) {
      const local = { ...rec, _localId: uid() };
      const next = [...loadPendingOps(), local];
      savePendingOps(next);
      setPendingOps(next);
      setOperations(prev => [{ ...rec, id: local._localId, _pending: true }, ...prev]);
      return;
    }
    const { error } = await supabase.from("operations").insert(rec);
    if (error) {
      // provável falha de rede no meio do caminho: guarda localmente também
      const local = { ...rec, _localId: uid() };
      const next = [...loadPendingOps(), local];
      savePendingOps(next);
      setPendingOps(next);
      setOperations(prev => [{ ...rec, id: local._localId, _pending: true }, ...prev]);
    } else {
      fetchAll();
    }
  }
  async function deleteOperation(id) {
    const { error } = await supabase.from("operations").delete().eq("id", id);
    if (error) setSaveError(error.message); else fetchAll();
  }
  async function addUser({ name, username, password, role, farmIds }) {
    const { data, error } = await supabase.functions.invoke("create-user", { body: { name, username, password, role, farmIds } });
    if (error) {
      let msg = error.message || "Não foi possível criar o usuário.";
      try {
        if (error.context && typeof error.context.json === "function") {
          const body = await error.context.json();
          if (body?.error) msg = body.error;
        }
      } catch (e) { /* mantém a mensagem genérica se não der pra ler o corpo */ }
      return msg;
    }
    if (data?.error) return data.error;
    await fetchAll();
    return null;
  }
  async function removeUser(id) {
    const gestorCount = profiles.filter(u => u.role === "gestor").length;
    const target = profiles.find(u => u.id === id);
    if (target?.role === "gestor" && gestorCount <= 1) return "Não é possível remover o único usuário Administrador.";
    const { error } = await supabase.from("profiles").delete().eq("id", id);
    if (error) return error.message;
    await fetchAll();
    return null;
  }

  /* ---------- render ---------- */
  if (authLoading) return <Shell><div className="loadingWrap"><Loader2 className="spin" size={28} /><span>Abrindo o Field Operations Book…</span></div><Style /></Shell>;
  if (!session) {
    if (hasAdmin === null) return <Shell><div className="loadingWrap"><Loader2 className="spin" size={28} /><span>Abrindo o Field Operations Book…</span></div><Style /></Shell>;
    return <Shell><LoginOrSetup onLogin={handleLogin} onFirstRunCreate={handleFirstRunCreate} hasAdmin={hasAdmin} /><Style /></Shell>;
  }
  if (!profile || dataLoading) {
    if (profileTimedOut) {
      return (
        <Shell>
          <div className="loadingWrap" style={{ flexDirection: "column", gap: 6, textAlign: "center" }}>
            <span>Não foi possível carregar seus dados agora.</span>
            <span style={{ fontSize: 12, opacity: 0.7 }}>{!navigator.onLine ? "Você está sem conexão e este aparelho ainda não tem dados salvos de uma vez anterior. Conecte à internet uma vez para carregar os dados iniciais." : "Verifique sua conexão e tente novamente."}</span>
          </div>
          <Style />
        </Shell>
      );
    }
    return <Shell><div className="loadingWrap"><Loader2 className="spin" size={28} /><span>Carregando seus dados…</span></div><Style /></Shell>;
  }

  const tabs = TABS_BY_ROLE[profile.role] || TABS_BY_ROLE.operador;
  const opMeta = buildOpMeta(opTypesRows);
  const enabledOpTypes = opTypesRows.map(r => r.key);

  const myFarmIds = profile.role === "gestor" ? null : (profile.farm_ids || []);
  const scopedFarms = myFarmIds === null ? farms : farms.filter(f => myFarmIds.includes(f.id));
  const scopedRetiros = myFarmIds === null ? retiros : retiros.filter(r => myFarmIds.includes(r.farm_id));
  const scopedFields = myFarmIds === null ? fields : fields.filter(f => myFarmIds.includes(f.farm_id));
  const scopedOperations = myFarmIds === null ? operations : operations.filter(o => myFarmIds.includes(o.farm_id));

  const hasFarms = scopedFarms.length > 0;
  const hasFields = scopedFields.length > 0;

  return (
    <Shell>
      <Header tab={tab} setTab={setTab} tabs={tabs} currentUser={profile} onLogout={handleLogout} />
      <OfflineBanner isOnline={isOnline} pendingCount={pendingOps.length} syncing={syncing} usingCache={usingCache} onSyncNow={syncPending} />
      {saveError && <div className="saveError">{saveError} <button className="dismissErr" onClick={() => setSaveError(null)}>×</button></div>}
      <main className="content">
        {tab === "painel" && (
          <Painel farms={scopedFarms} retiros={scopedRetiros} fields={scopedFields} operations={scopedOperations} profiles={profiles}
            hasFarms={hasFarms} hasFields={hasFields} enabledOpTypes={enabledOpTypes} opMeta={opMeta}
            goCadastro={() => setTab("cadastro")} goLancamento={profile.role === "operador" ? () => setTab("lancamento") : null}
            canGoCadastro={profile.role === "gestor"} />
        )}
        {tab === "lancamento" && profile.role === "operador" && (
          <Lancamento farms={scopedFarms} retiros={scopedRetiros} fields={scopedFields} hasFarms={hasFarms} hasFields={hasFields}
            enabledOpTypes={enabledOpTypes} opMeta={opMeta} machines={machines} operations={scopedOperations} currentUser={profile} onSubmit={addOperation} />
        )}
        {tab === "historico" && (
          <Historico farms={scopedFarms} retiros={scopedRetiros} fields={scopedFields} operations={scopedOperations} profiles={profiles} currentUser={profile} opMeta={opMeta} onDelete={deleteOperation} />
        )}
        {tab === "cadastro" && profile.role === "gestor" && (
          <Cadastro
            farms={farms} retiros={retiros} fields={fields} machines={machines} opTypesRows={opTypesRows} opMeta={opMeta}
            users={profiles} currentUser={profile}
            onAddFarm={addFarm} onRemoveFarm={removeFarm}
            onAddRetiro={addRetiro} onRemoveRetiro={removeRetiro}
            onRemoveField={removeField} onImportKml={importKml}
            onAddMachine={addMachine} onRemoveMachine={removeMachine} onUpdateMachineFarm={updateMachineFarm}
            onAddCustomOpType={addCustomOpType}
            onAddUser={addUser} onRemoveUser={removeUser}
          />
        )}
      </main>
      <Style />
    </Shell>
  );
}

function Shell({ children }) { return <div className="app">{children}</div>; }

function OfflineBanner({ isOnline, pendingCount, syncing, usingCache, onSyncNow }) {
  if (isOnline && pendingCount === 0 && !usingCache) return null;
  return (
    <div className={"offlineBanner" + (!isOnline ? " offline" : "")}>
      {!isOnline ? (
        <><WifiOff size={13} /> Sem conexão — {pendingCount > 0 ? `${pendingCount} lançamento(s) serão enviados quando a internet voltar.` : "os dados mostrados são os últimos salvos neste aparelho."}</>
      ) : pendingCount > 0 ? (
        <>
          <RefreshCw size={13} className={syncing ? "spin" : ""} />
          {syncing ? "Sincronizando lançamentos pendentes…" : `${pendingCount} lançamento(s) pendente(s) de sincronização.`}
          {!syncing && <button className="offlineSyncBtn" onClick={onSyncNow} type="button">Sincronizar agora</button>}
        </>
      ) : (
        <>Mostrando dados salvos neste aparelho (sem conexão no último carregamento).</>
      )}
    </div>
  );
}

/* ---------------- LOGIN / SETUP ---------------- */

function AuthShell({ title, subtitle, children }) {
  return (
    <div className="authWrap">
      <img src="/icons/icon-512.png" alt="" className="authBrandImg" aria-hidden="true" />
      <h2 className="authTitle">{title}</h2>
      <p className="authSub">{subtitle}</p>
      <div className="authCard">
        {children}
      </div>
      <div className="authFooterWrap">
        <div className="authFooterLabel">Uma solução criada por</div>
        <img src="/visao-agropecuaria-logo.png" alt="Visão Agropecuária" className="authFooterLogo" />
      </div>
    </div>
  );
}

function LoginOrSetup({ onLogin, onFirstRunCreate, hasAdmin }) {
  const [mode, setMode] = useState(hasAdmin ? "login" : "setup");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setError(""); setBusy(true);
    const err = mode === "login" ? await onLogin(username, password) : await onFirstRunCreate({ name, username, password });
    setBusy(false);
    if (err) setError(err);
  }
  function handleKeyDown(e) { if (e.key === "Enter") handleSubmit(); }

  return (
    <AuthShell
      title="Field Operations Book"
      subtitle={mode === "login" ? "Entre com seu usuário para lançar operações ou consultar relatórios." : "Crie o usuário Administrador inicial do sistema (use isso apenas uma vez, na primeira configuração)."}
    >
      <div className="authForm" onKeyDown={handleKeyDown}>
        {mode === "setup" && <Field label="Nome completo"><input value={name} onChange={e => setName(e.target.value)} /></Field>}
        <Field label="Usuário"><input autoFocus value={username} onChange={e => setUsername(e.target.value)} /></Field>
        <Field label="Senha"><input type="password" value={password} onChange={e => setPassword(e.target.value)} /></Field>
        {error && <div className="authError">{error}</div>}
        <button className="btnPrimary authSubmit" type="button" onClick={handleSubmit} disabled={busy}>
          <Lock size={15} /> {busy ? "Aguarde…" : mode === "login" ? "Entrar" : "Criar usuário Administrador"}
        </button>
      </div>
      {!hasAdmin && (
        <button className="authSwitch" type="button" onClick={() => { setMode(mode === "login" ? "setup" : "login"); setError(""); }}>
          {mode === "login" ? "Primeiro acesso? Criar o usuário Administrador inicial" : "Já tenho usuário — voltar ao login"}
        </button>
      )}
    </AuthShell>
  );
}

/* ---------------- HEADER ---------------- */

function Header({ tab, setTab, tabs, currentUser, onLogout }) {
  const roleMeta = ROLE_META[currentUser.role] || ROLE_META.operador;
  return (
    <header className="header">
      <div className="headerTop">
        <div className="brand">
          <div className="brandMark" aria-hidden="true"><SproutIcon size={18} strokeWidth={2.25} /></div>
          <div>
            <div className="brandTitle">Field Operations Book</div>
            <div className="brandSub">Registro diário de operações a campo</div>
          </div>
        </div>
        <div className="headerRight">
          <div className="userBadge">
            <span className="userName">{currentUser.name}</span>
            <span className="rolePill" style={{ "--role-color": roleMeta.color }}>{roleMeta.label}</span>
          </div>
          <button className="iconBtn logoutBtn" onClick={onLogout} title="Sair"><LogOut size={15} /></button>
        </div>
      </div>
      <nav className="tabs">
        {tabs.map(t => { const Icon = t.icon; return <button key={t.id} className={"tabBtn" + (tab === t.id ? " active" : "")} onClick={() => setTab(t.id)}><Icon size={15} />{t.label}</button>; })}
      </nav>
    </header>
  );
}

/* ---------------- PAINEL ---------------- */

function Painel({ farms, retiros, fields, operations, profiles, hasFarms, hasFields, enabledOpTypes, opMeta, goCadastro, goLancamento, canGoCadastro }) {
  const isDesktop = useIsDesktop();
  const [farmFilter, setFarmFilter] = useState("all");
  const [operFilter, setOperFilter] = useState("all");
  const [retiroFilter, setRetiroFilter] = useState("all");
  const [operatorFilter, setOperatorFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [chartMode, setChartMode] = useState("dias");

  useEffect(() => {
    setRetiroFilter(prev => {
      if (prev === "all") return prev;
      const r = (retiros || []).find(x => x.id === prev);
      if (!r) return "all";
      if (farmFilter !== "all" && r.farm_id !== farmFilter) return "all";
      return prev;
    });
    // eslint-disable-next-line
  }, [farmFilter]);

  if (!hasFarms || !hasFields) {
    return (
      <EmptyState
        title={!hasFarms ? "Nenhuma fazenda cadastrada" : "Nenhum talhão cadastrado"}
        text={canGoCadastro ? "Cadastre suas fazendas e talhões (ou importe um KML com os polígonos) para começar." : "Peça a um Administrador para cadastrar as fazendas e talhões antes de lançar operações."}
        actionLabel={canGoCadastro ? "Ir para Cadastro" : null} onAction={goCadastro}
      />
    );
  }

  const operatorOptions = [];
  const seenOperators = new Set();
  operations.forEach(o => {
    if (o.operator_id && !seenOperators.has(o.operator_id)) {
      seenOperators.add(o.operator_id);
      const p = profiles.find(pr => pr.id === o.operator_id);
      operatorOptions.push({ id: o.operator_id, name: p?.name || "—" });
    }
  });
  operatorOptions.sort((a, b) => a.name.localeCompare(b.name));

  const farmOptions = [...farms].sort((a, b) => a.name.localeCompare(b.name));
  const retiroOptions = [...(retiros || [])].filter(r => farmFilter === "all" || r.farm_id === farmFilter).sort((a, b) => a.name.localeCompare(b.name));

  const hasActiveFilters = farmFilter !== "all" || operFilter !== "all" || retiroFilter !== "all" || operatorFilter !== "all" || dateFrom || dateTo;
  const filteredOperations = operations.filter(o => {
    if (farmFilter !== "all" && o.farm_id !== farmFilter) return false;
    if (operFilter !== "all" && o.op_type !== operFilter) return false;
    if (retiroFilter !== "all" && o.retiro_id !== retiroFilter) return false;
    if (operatorFilter !== "all" && o.operator_id !== operatorFilter) return false;
    if (dateFrom && o.date < dateFrom) return false;
    if (dateTo && o.date > dateTo) return false;
    return true;
  });

  const areaPeriodo = filteredOperations.reduce((s, o) => s + (Number(o.area_worked) || 0), 0);
  const comHoras = filteredOperations.filter(o => o.hours > 0 && o.area_worked > 0);
  const areaComHoras = comHoras.reduce((s, o) => s + Number(o.area_worked), 0);
  const horasComArea = comHoras.reduce((s, o) => s + Number(o.hours), 0);
  const rendimentoOperacional = horasComArea > 0 ? areaComHoras / horasComArea : null;
  const diasComLancamento = new Set(filteredOperations.map(o => o.date).filter(Boolean)).size;
  const areaMediaPorDia = diasComLancamento > 0 ? areaPeriodo / diasComLancamento : null;

  // horas trabalhadas por dia: para cada dia, a média das horas de cada operador naquele dia;
  // o indicador do período é a média dessas médias diárias (não a soma de todo mundo dividida pelos dias).
  const hoursByDayOperator = {};
  filteredOperations.forEach(o => {
    if (!o.date) return;
    const opId = o.operator_id || "—";
    if (!hoursByDayOperator[o.date]) hoursByDayOperator[o.date] = {};
    hoursByDayOperator[o.date][opId] = (hoursByDayOperator[o.date][opId] || 0) + (Number(o.hours) || 0);
  });
  const dailyOperatorAverages = Object.values(hoursByDayOperator).map(operatorHours => {
    const vals = Object.values(operatorHours);
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  });
  const horasPorDia = dailyOperatorAverages.length > 0
    ? dailyOperatorAverages.reduce((s, v) => s + v, 0) / dailyOperatorAverages.length
    : null;

  const msPerDay = 24 * 60 * 60 * 1000;
  let chartData = [];
  let chartCapped = false;
  if (chartMode === "dias") {
    let rangeEnd = dateTo ? new Date(dateTo + "T00:00:00") : new Date();
    let rangeStart = dateFrom ? new Date(dateFrom + "T00:00:00") : (dateTo ? new Date(new Date(dateTo + "T00:00:00").getTime() - 13 * msPerDay) : new Date(rangeEnd.getTime() - 13 * msPerDay));
    let spanDays = Math.round((rangeEnd - rangeStart) / msPerDay) + 1;
    if (spanDays < 1) spanDays = 1;
    if (spanDays > 60) { rangeStart = new Date(rangeEnd.getTime() - 59 * msPerDay); spanDays = 60; chartCapped = true; }
    for (let i = 0; i < spanDays; i++) {
      const d = new Date(rangeStart.getTime() + i * msPerDay);
      const iso = d.toISOString().slice(0, 10);
      const total = filteredOperations.filter(o => o.date === iso).reduce((s, o) => s + (Number(o.area_worked) || 0), 0);
      chartData.push({ label: iso.slice(8, 10) + "/" + iso.slice(5, 7), ha: Math.round(total * 10) / 10 });
    }
  } else {
    const rangeEndD = dateTo ? new Date(dateTo + "T00:00:00") : new Date();
    let rangeStartD;
    if (dateFrom) rangeStartD = new Date(dateFrom + "T00:00:00");
    else { rangeStartD = new Date(rangeEndD); rangeStartD.setMonth(rangeStartD.getMonth() - 11); }
    let cursor = new Date(rangeStartD.getFullYear(), rangeStartD.getMonth(), 1);
    const endCursor = new Date(rangeEndD.getFullYear(), rangeEndD.getMonth(), 1);
    let months = [];
    while (cursor <= endCursor && months.length < 300) { months.push(new Date(cursor)); cursor.setMonth(cursor.getMonth() + 1); }
    if (months.length > 24) { months = months.slice(months.length - 24); chartCapped = true; }
    const MESES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    chartData = months.map(m => {
      const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
      const total = filteredOperations.filter(o => o.date && o.date.startsWith(key)).reduce((s, o) => s + (Number(o.area_worked) || 0), 0);
      return { label: `${MESES_ABREV[m.getMonth()]}/${String(m.getFullYear()).slice(2)}`, ha: Math.round(total * 10) / 10 };
    });
  }

  const mapFields = fields.filter(f => (farmFilter === "all" || f.farm_id === farmFilter) && (retiroFilter === "all" || f.retiro_id === retiroFilter));
  const mapPolyFields = mapFields.filter(f => f.coords && f.coords.length >= 3);
  const mapPlainFields = mapFields.filter(f => !(f.coords && f.coords.length >= 3));
  const anyPolygon = fields.some(f => f.coords && f.coords.length >= 3);

  let mapHeading, mapSubheading;
  if (retiroFilter !== "all") {
    const r = retiroOptions.find(x => x.id === retiroFilter);
    mapHeading = r ? `Retiro: ${r.name}` : "Retiro selecionado";
    const farmOfRetiro = farms.find(fa => fa.id === r?.farm_id);
    mapSubheading = farmOfRetiro ? farmOfRetiro.name : null;
  } else if (farmFilter !== "all") {
    const fa = farmOptions.find(x => x.id === farmFilter);
    mapHeading = fa ? fa.name : "Fazenda selecionada";
    mapSubheading = null;
  } else {
    const retiroIdsShown = new Set(mapFields.map(f => f.retiro_id).filter(Boolean));
    const farmNames = [...new Set(mapFields.map(f => farms.find(fa => fa.id === f.farm_id)?.name).filter(Boolean))];
    mapHeading = farmNames.length === 1 ? farmNames[0] : (farmNames.length > 1 ? "Todas as fazendas" : "Talhões");
    mapSubheading = retiroIdsShown.size > 1 ? `${retiroIdsShown.size} retiros exibidos juntos, nas posições reais` : null;
  }

  return (
    <div className="painel">
      <section className="panel filterPanel">
        <div className="panelHead">
          <h2>Filtros</h2>
          {hasActiveFilters && (
            <button className="filterClear" type="button" onClick={() => { setFarmFilter("all"); setOperFilter("all"); setRetiroFilter("all"); setOperatorFilter("all"); setDateFrom(""); setDateTo(""); }}>Limpar filtros</button>
          )}
        </div>
        <div className="filterRow">
          <div className="filterGroup">
            <span className="filterLabel">Fazenda</span>
            <select value={farmFilter} onChange={e => setFarmFilter(e.target.value)}>
              <option value="all">Todas</option>
              {farmOptions.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <div className="filterGroup">
            <span className="filterLabel">Operação</span>
            <select value={operFilter} onChange={e => setOperFilter(e.target.value)}>
              <option value="all">Todas</option>
              {Object.entries(opMeta).filter(([key]) => enabledOpTypes.includes(key)).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
          </div>
          <div className="filterGroup">
            <span className="filterLabel">Retiro</span>
            <select value={retiroFilter} onChange={e => setRetiroFilter(e.target.value)}>
              <option value="all">Todos</option>
              {retiroOptions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div className="filterGroup">
            <span className="filterLabel">Operador</span>
            <select value={operatorFilter} onChange={e => setOperatorFilter(e.target.value)}>
              <option value="all">Todos</option>
              {operatorOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div className="filterGroup">
            <span className="filterLabel">Período</span>
            <div className="filterDates">
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              <span>até</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </div>
          </div>
        </div>
      </section>

      <div className="kpiGrid">
        <KpiCard label="Área trabalhada no período" value={fmtNum(areaPeriodo)} unit="ha" icon={MapPin} accent="#4F7942" />
        <KpiCard label="Rendimento operacional" value={rendimentoOperacional !== null ? fmtNum(rendimentoOperacional, 2) : "—"} unit="ha/h" icon={BarChart3} accent="#3E7C8C" />
        <KpiCard label="Área média por dia" value={areaMediaPorDia !== null ? fmtNum(areaMediaPorDia, 1) : "—"} unit={areaMediaPorDia !== null ? "ha/dia" : ""} icon={Calendar} accent="#C9A227" />
        <KpiCard label="Horas trabalhadas por dia" value={horasPorDia !== null ? fmtNum(horasPorDia, 1) : "—"} unit={horasPorDia !== null ? "h/dia" : ""} icon={Clock} accent="#A85C36" />
      </div>

      <section className="panel">
        <div className="panelHead">
          <h2>Área trabalhada</h2>
          <div className="chartModeRow">
            <button type="button" className={"chartModeBtn" + (chartMode === "dias" ? " active" : "")} onClick={() => setChartMode("dias")}>Dias</button>
            <button type="button" className={"chartModeBtn" + (chartMode === "meses" ? " active" : "")} onClick={() => setChartMode("meses")}>Meses</button>
          </div>
        </div>
        {chartCapped && <p className="panelHint" style={{ marginBottom: 8 }}>Mostrando só o trecho mais recente do período selecionado.</p>}
        <div className="chartWrap">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="rgba(36,27,20,0.08)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6b5c47" }} axisLine={{ stroke: "rgba(36,27,20,0.15)" }} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#6b5c47" }} axisLine={false} tickLine={false} width={34} />
              <Tooltip formatter={(v) => [`${v} ha`, "Área"]} labelFormatter={(l) => (chartMode === "dias" ? `Dia ${l}` : l)} contentStyle={{ background: "#EDE6D6", border: "1px solid rgba(36,27,20,0.15)", borderRadius: 6, fontSize: 12 }} />
              <Bar dataKey="ha" radius={[3, 3, 0, 0]} fill="#4F7942" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {isDesktop ? (
        <section className="panel">
          <div className="panelHead"><h2>Mapa das fazendas</h2></div>
          <MapLegend enabledOpTypes={enabledOpTypes} opMeta={opMeta} />
          {mapFields.length > 0 ? (
            <div className="farmMapGroup">
              <div className="farmMapLabel">{mapHeading}</div>
              {mapSubheading && <div className="subGroupLabel">{mapSubheading}</div>}
              {mapPolyFields.length > 0 && <FarmPolygonMap fields={mapPolyFields} operations={filteredOperations} opMeta={opMeta} />}
              {mapPlainFields.length > 0 && (
                <>
                  {mapPolyFields.length > 0 && <div className="subGroupLabel">Sem polígono importado</div>}
                  <div className="fieldGrid">{mapPlainFields.map(field => <FieldTile key={field.id} field={field} operations={filteredOperations.filter(o => o.field_id === field.id)} opMeta={opMeta} />)}</div>
                </>
              )}
            </div>
          ) : (
            <p className="mapTip">Nenhum talhão encontrado para os filtros atuais.</p>
          )}
          {!anyPolygon && <p className="mapTip">{canGoCadastro ? <>Dica: importe um arquivo KML com os polígonos dos talhões na aba <strong>Cadastro</strong>.</> : "Ainda não há polígonos importados para essas fazendas."}</p>}
        </section>
      ) : (
        <p className="mapMobileNotice">O mapa das fazendas está disponível na versão para computador — no celular, veja os indicadores e o gráfico acima.</p>
      )}

      {goLancamento && <div className="quickAdd"><button className="btnPrimary" onClick={goLancamento}><Plus size={16} /> Novo lançamento</button></div>}
    </div>
  );
}

function MapLegend({ enabledOpTypes, opMeta }) {
  return (
    <div className="legend">
      {Object.entries(opMeta).filter(([k]) => enabledOpTypes.includes(k)).map(([k, m]) => <span key={k} className="legendItem"><i style={{ background: m.color }} />{m.label}</span>)}
      <span className="legendItem"><i style={{ background: SOIL_BARE }} />Sem lançamento</span>
    </div>
  );
}
function KpiCard({ label, value, unit, icon: Icon, accent }) {
  return (
    <div className="kpiCard" style={{ "--accent": accent }}>
      <div className="kpiIcon"><Icon size={16} /></div>
      <div className="kpiLabel">{label}</div>
      <div className="kpiValue">{value}{unit && <span className="kpiUnit">{unit}</span>}</div>
    </div>
  );
}

function FarmPolygonMap({ fields, operations, opMeta }) {
  const width = 640, height = 360;
  const [imgError, setImgError] = useState(false);
  const [imgUrlIndex, setImgUrlIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [showName, setShowName] = useState(true);
  const [showArea, setShowArea] = useState(true);
  const [showPct, setShowPct] = useState(true);
  const svgRef = useRef(null);
  const dragRef = useRef({ startX: 0, startY: 0, panX: 0, panY: 0 });

  function clampPan(p, z) {
    const maxX = ((z - 1) * width) / 2, maxY = ((z - 1) * height) / 2;
    return { x: Math.max(-maxX, Math.min(maxX, p.x)), y: Math.max(-maxY, Math.min(maxY, p.y)) };
  }
  function handleMouseDown(e) {
    if (zoom <= 1) return;
    setDragging(true);
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  }
  function handleTouchStart(e) {
    if (zoom <= 1 || e.touches.length !== 1) return;
    const t = e.touches[0];
    setDragging(true);
    dragRef.current = { startX: t.clientX, startY: t.clientY, panX: pan.x, panY: pan.y };
  }
  useEffect(() => {
    if (!dragging) return;
    function applyDelta(clientX, clientY) {
      const svg = svgRef.current; if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const dx = (clientX - dragRef.current.startX) * (width / rect.width);
      const dy = (clientY - dragRef.current.startY) * (height / rect.height);
      setPan(clampPan({ x: dragRef.current.panX + dx, y: dragRef.current.panY + dy }, zoom));
    }
    function onMove(e) { applyDelta(e.clientX, e.clientY); }
    function onUp() { setDragging(false); }
    function onTouchMove(e) { if (e.touches.length !== 1) return; e.preventDefault(); applyDelta(e.touches[0].clientX, e.touches[0].clientY); }
    function onTouchEnd() { setDragging(false); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);
    return () => {
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onTouchMove); window.removeEventListener("touchend", onTouchEnd); window.removeEventListener("touchcancel", onTouchEnd);
    };
    // eslint-disable-next-line
  }, [dragging, zoom]);
  function zoomIn() { setZoom(z => { const nz = Math.min(4, Math.round((z + 0.5) * 100) / 100); setPan(p => clampPan(p, nz)); return nz; }); }
  function zoomOut() { setZoom(z => { const nz = Math.max(1, Math.round((z - 0.5) * 100) / 100); setPan(p => clampPan(p, nz)); return nz; }); }
  function zoomReset() { setZoom(1); setPan({ x: 0, y: 0 }); }

  const built = useMemo(() => {
    const bbox = computeBBox(fields);
    if (!bbox) return null;
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const lngCorrection = Math.cos((midLat * Math.PI) / 180) || 1;
    const lngSpan = bbox.maxLng - bbox.minLng;
    const latSpan = bbox.maxLat - bbox.minLat || 1e-6;
    const targetAspect = width / height;
    const dataAspect = (lngSpan * lngCorrection) / latSpan;
    let { minLng, maxLng, minLat, maxLat } = bbox;
    if (dataAspect > targetAspect) {
      const neededLatSpan = (lngSpan * lngCorrection) / targetAspect;
      const extra = (neededLatSpan - latSpan) / 2;
      minLat -= extra; maxLat += extra;
    } else {
      const neededLngSpan = (latSpan * targetAspect) / lngCorrection;
      const extra = (neededLngSpan - lngSpan) / 2;
      minLng -= extra; maxLng += extra;
    }
    const xScale = d3.scaleLinear().domain([minLng, maxLng]).range([0, width]);
    const yScale = d3.scaleLinear().domain([minLat, maxLat]).range([height, 0]);
    const project = ([lng, lat]) => [xScale(lng), yScale(lat)];
    const items = fields.map(f => {
      const ring = f.coords || [];
      const pts = ring.map(project);
      const d = pts.length ? "M" + pts.map(p => p.join(",")).join("L") + "Z" : "";
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const bounds = pts.length ? [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]] : [[0, 0], [0, 0]];
      const centroid = pts.length ? [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2] : [0, 0];
      const ops = operations.filter(o => o.field_id === f.id);
      const { last, meta, pct } = fieldProgress(f, ops, opMeta);
      return { field: f, d, bounds, centroid, last, meta, pct };
    });
    const imgW = width * 2, imgH = height * 2;
    const buildUrl = (host, format) => `https://${host}/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${minLng},${minLat},${maxLng},${maxLat}&bboxSR=4326&imageSR=4326&size=${imgW},${imgH}&format=${format}&f=image&transparent=false&dpi=192`;
    const imageUrls = [buildUrl("server.arcgisonline.com", "png32"), buildUrl("services.arcgisonline.com", "png32"), buildUrl("server.arcgisonline.com", "jpgpng")];
    return { items, imageUrls };
    // eslint-disable-next-line
  }, [fields.map(f => f.id + "-" + (f.coords || []).length).join("|"), operations.length, opMeta]);

  useEffect(() => { setImgUrlIndex(0); setImgError(false); setZoom(1); setPan({ x: 0, y: 0 }); }, [built && built.imageUrls && built.imageUrls[0]]);

  if (!built) return null;
  const { items, imageUrls } = built;
  const currentImageUrl = imageUrls[imgUrlIndex];
  const zoomTx = (width / 2) * (1 - zoom) + pan.x;
  const zoomTy = (height / 2) * (1 - zoom) + pan.y;

  return (
    <div className="farmSatWrap">
      <div className="mapControls">
        <button type="button" className={"mapToggleBtn" + (showName ? " active" : "")} onClick={() => setShowName(v => !v)}>Nome</button>
        <button type="button" className={"mapToggleBtn" + (showArea ? " active" : "")} onClick={() => setShowArea(v => !v)}>Área</button>
        <button type="button" className={"mapToggleBtn" + (showPct ? " active" : "")} onClick={() => setShowPct(v => !v)}>%</button>
      </div>
      <div className="mapZoomControls">
        <button type="button" className="mapZoomBtn" onClick={zoomIn} title="Aumentar zoom"><ZoomIn size={14} /></button>
        <button type="button" className="mapZoomBtn" onClick={zoomOut} title="Diminuir zoom"><ZoomOut size={14} /></button>
        <button type="button" className="mapZoomBtn" onClick={zoomReset} title="Restaurar zoom"><Maximize2 size={13} /></button>
      </div>
      <svg ref={svgRef} className={"farmSvgMap" + (zoom > 1 ? (dragging ? " dragging" : " draggable") : "")} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" onMouseDown={handleMouseDown} onTouchStart={handleTouchStart}>
        <defs>
          <pattern id="soilFallback" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
            <rect width="12" height="12" fill="#332a1c" /><rect width="5" height="12" fill="#3c3122" />
          </pattern>
          <linearGradient id="soilFallbackShade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4a3c28" stopOpacity="0.5" /><stop offset="100%" stopColor="#241b14" stopOpacity="0.65" />
          </linearGradient>
          {items.map(({ field, bounds, pct }) => {
            const [[x0, y0], [x1, y1]] = bounds;
            const h = Math.max(0, y1 - y0), w = Math.max(0, x1 - x0), fillH = (pct / 100) * h;
            return <clipPath id={`clip-${field.id}`} key={field.id}><rect x={x0} y={y1 - fillH} width={w} height={fillH} /></clipPath>;
          })}
        </defs>
        <g transform={`translate(${zoomTx},${zoomTy}) scale(${zoom})`}>
          {!imgError ? (
            <image href={currentImageUrl} x={0} y={0} width={width} height={height} preserveAspectRatio="none"
              onError={() => { if (imgUrlIndex < imageUrls.length - 1) setImgUrlIndex(i => i + 1); else setImgError(true); }}
              onDragStart={(e) => e.preventDefault()} draggable={false} />
          ) : (
            <><rect x={0} y={0} width={width} height={height} fill="url(#soilFallback)" /><rect x={0} y={0} width={width} height={height} fill="url(#soilFallbackShade)" /></>
          )}
          {items.map(({ field, d, meta }) => <path key={field.id + "-base"} d={d} fill={meta ? hexA(meta.color, 0.28) : "rgba(255,255,255,0.3)"} stroke="rgba(255,255,255,0.85)" strokeWidth={0.7} strokeLinejoin="round" />)}
          {items.map(({ field, d, meta, pct }) => meta && pct > 0 ? <path key={field.id + "-fill"} d={d} fill={hexA(meta.color, 0.8)} clipPath={`url(#clip-${field.id})`} pointerEvents="none" /> : null)}
          {items.map(({ field, d }) => <path key={field.id + "-outline"} d={d} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth={0.7} strokeLinejoin="round" />)}
          {items.map(({ field, centroid, meta, pct }) => {
            const parts = [];
            if (showArea) parts.push(`${fmtNum(field.area_ha)} ha`);
            if (showPct && meta) parts.push(`${fmtNum(pct, 0)}%`);
            const subLine = parts.join(" · ");
            return (
              <g key={field.id + "-label"} transform={`translate(${centroid[0]},${centroid[1]})`} textAnchor="middle">
                {showName && <text y={-3} className="mapFieldName">{field.name}</text>}
                {subLine && <text y={showName ? 11 : 3} className="mapFieldSub">{subLine}</text>}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="mapAttribution">{!imgError ? "Imagens de satélite: Esri, Maxar, Earthstar Geographics" : "Não foi possível carregar a imagem de satélite agora."}</div>
    </div>
  );
}

function FieldTile({ field, operations, opMeta }) {
  const { last, meta, pct } = fieldProgress(field, operations, opMeta);
  const Icon = meta ? meta.icon : Circle;
  const baseColor = meta ? meta.color : SOIL_BARE;
  const size = Math.max(96, Math.min(180, Math.sqrt(field.area_ha || 1) * 34));
  return (
    <div className="fieldTile" style={{ flexBasis: `${size}px`, background: `linear-gradient(180deg, ${hexA(baseColor, 0.16)}, ${hexA(baseColor, 0.05)})`, borderColor: hexA(baseColor, 0.4) }}
      title={last ? `Última: ${meta.label} em ${fmtDateBR(last.date)}` : "Sem lançamentos"}>
      <div className="fieldTileRows" aria-hidden="true" />
      <div className="fieldTileTop"><Icon size={14} color={baseColor} /><span>{field.name}</span></div>
      <div className="fieldTileArea">{fmtNum(field.area_ha)} ha</div>
      <div className="fieldTileBarWrap"><div className="fieldTileBar" style={{ width: `${pct}%`, background: baseColor }} /></div>
      <div className="fieldTilePct">{meta ? `${fmtNum(pct, 0)}% ${meta.label.toLowerCase()}` : "sem lançamento"}</div>
    </div>
  );
}

/* ---------------- LANÇAMENTO ---------------- */

function Lancamento({ farms, retiros, fields, hasFarms, hasFields, enabledOpTypes, opMeta, machines, operations, currentUser, onSubmit }) {
  const opTypeList = Object.entries(opMeta).filter(([key]) => enabledOpTypes.includes(key));
  const [date, setDate] = useState(todayISO());
  const [farmId, setFarmId] = useState("");
  const [retiroId, setRetiroId] = useState("");
  const [fieldId, setFieldId] = useState("");
  const [opType, setOpType] = useState("");
  const [machineId, setMachineId] = useState("");
  const [areaWorked, setAreaWorked] = useState("");
  const [horIni, setHorIni] = useState("");
  const [horIniSuggested, setHorIniSuggested] = useState(false);
  const [horFim, setHorFim] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("sc");
  const [notes, setNotes] = useState("");
  const [confirmMsg, setConfirmMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const retirosOfFarm = (retiros || []).filter(r => r.farm_id === farmId);
  const fieldsOfRetiro = fields.filter(f => f.retiro_id === retiroId);
  const machinesForFarm = (machines || []).filter(m => !m.farm_id || m.farm_id === farmId);

  const horIniNum = horIni === "" ? null : parseFloat(horIni);
  const horFimNum = horFim === "" ? null : parseFloat(horFim);
  let horimetroError = "";
  if (horIniNum === null || horFimNum === null) horimetroError = "Informe o horímetro inicial e o horímetro final.";
  else if (horFimNum < horIniNum) horimetroError = "O horímetro final não pode ser menor que o inicial.";
  else if (horFimNum - horIniNum > 12) horimetroError = "A diferença entre os horímetros não pode ser maior que 12 horas.";
  const hoursComputed = horIniNum !== null && horFimNum !== null && !horimetroError ? Math.round((horFimNum - horIniNum) * 100) / 100 : null;

  const selectedField = fieldsOfRetiro.find(f => f.id === fieldId) || null;
  const areaWorkedNum = areaWorked === "" ? null : parseFloat(areaWorked);
  const areaLimit = selectedField ? selectedField.area_ha * 1.1 : null;
  let areaError = "";
  if (areaWorkedNum !== null && areaLimit !== null && areaWorkedNum > areaLimit) {
    areaError = `A área trabalhada não pode passar de 110% da área do talhão (máximo ${fmtNum(areaLimit, 2)} ha para este talhão).`;
  }

  useEffect(() => { if (!retirosOfFarm.find(r => r.id === retiroId)) setRetiroId(""); /* eslint-disable-next-line */ }, [farmId, retiros && retiros.length]);
  useEffect(() => { if (!fieldsOfRetiro.find(f => f.id === fieldId)) setFieldId(""); /* eslint-disable-next-line */ }, [retiroId, fields.length]);
  useEffect(() => { if (opType && !opTypeList.find(([key]) => key === opType)) setOpType(""); /* eslint-disable-next-line */ }, [enabledOpTypes.join(",")]);
  useEffect(() => { if (machineId && !machinesForFarm.find(m => m.id === machineId)) setMachineId(""); /* eslint-disable-next-line */ }, [farmId, machines && machines.length]);

  // sugere o horímetro inicial a partir do último horímetro final lançado para a máquina escolhida
  useEffect(() => {
    if (!machineId) return;
    if (horIni !== "" && !horIniSuggested) return;
    const machineOps = (operations || []).filter(o => o.machine_id === machineId && o.horimetro_final !== null && o.horimetro_final !== undefined);
    if (!machineOps.length) { setHorIni(""); setHorIniSuggested(false); return; }
    const sorted = [...machineOps].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? 1 : -1)));
    setHorIni(String(sorted[0].horimetro_final));
    setHorIniSuggested(true);
    // eslint-disable-next-line
  }, [machineId]);

  if (!hasFarms || !hasFields) return <EmptyState title={!hasFarms ? "Nenhuma fazenda cadastrada" : "Nenhum talhão cadastrado"} text="Peça a um Administrador para cadastrar pelo menos uma fazenda, um retiro e um talhão antes de lançar operações." />;

  const selectedMachine = machinesForFarm.find(m => m.id === machineId) || null;
  const canSubmit = farmId && retiroId && fieldId && opType && machineId && areaWorked && !horimetroError && !areaError && !busy;

  async function handleRegister() {
    if (!canSubmit) return;
    setBusy(true);
    await onSubmit({
      date, farm_id: farmId, retiro_id: retiroId, field_id: fieldId, op_type: opType,
      machine_id: machineId,
      machine: selectedMachine ? selectedMachine.name : null,
      area_worked: parseFloat(areaWorked) || 0,
      horimetro_inicial: horIniNum,
      horimetro_final: horFimNum,
      hours: hoursComputed || 0,
      quantity: quantity ? parseFloat(quantity) : null,
      unit: quantity ? unit : null,
      operator_id: currentUser.id,
      notes: notes.trim() || null,
    });
    setBusy(false);
    setConfirmMsg("Lançamento registrado.");
    setFarmId(""); setRetiroId(""); setFieldId(""); setOpType(""); setMachineId("");
    setAreaWorked(""); setHorIni(""); setHorIniSuggested(false); setHorFim(""); setQuantity(""); setNotes("");
    setTimeout(() => setConfirmMsg(""), 2500);
  }

  return (
    <div className="lancamentoWrap">
      <div className="panel formPanel">
        <div className="panelHead"><h2>Novo lançamento</h2><span className="panelHint">Lançando como <strong>{currentUser.name}</strong></span></div>
        <div className="formGrid">
          <Field label="Data"><input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
          <Field label="Operação">
            <select value={opType} onChange={e => setOpType(e.target.value)}>
              <option value="" disabled>Selecione a operação</option>
              {[...opTypeList].sort((a, b) => a[1].label.localeCompare(b[1].label, "pt-BR")).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
          </Field>
          <Field label="Fazenda">
            <select value={farmId} onChange={e => setFarmId(e.target.value)}>
              <option value="" disabled>Selecione a fazenda</option>
              {farms.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="Retiro">
            <select value={retiroId} onChange={e => setRetiroId(e.target.value)} disabled={!retirosOfFarm.length}>
              <option value="" disabled>{retirosOfFarm.length ? "Selecione o retiro" : "Sem retiros nesta fazenda"}</option>
              {retirosOfFarm.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          <Field label="Talhão">
            <select value={fieldId} onChange={e => setFieldId(e.target.value)} disabled={!fieldsOfRetiro.length}>
              <option value="" disabled>{fieldsOfRetiro.length ? "Selecione o talhão" : "Sem talhões neste retiro"}</option>
              {fieldsOfRetiro.map(f => <option key={f.id} value={f.id}>{f.name} ({fmtNum(f.area_ha)} ha)</option>)}
            </select>
          </Field>
          <Field label="Máquina">
            <select value={machineId} onChange={e => setMachineId(e.target.value)} disabled={!machinesForFarm.length}>
              <option value="" disabled>{machinesForFarm.length ? "Selecione a máquina" : "Nenhuma máquina disponível para esta fazenda"}</option>
              {machinesForFarm.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Área trabalhada (ha)"><input type="number" min="0" step="0.1" value={areaWorked} onChange={e => setAreaWorked(e.target.value)} /></Field>
          <Field label={horIniSuggested && horIni !== "" ? "Horímetro inicial (sugerido)" : "Horímetro inicial"}>
            <input type="number" min="0" step="0.1" value={horIni} onChange={e => { setHorIni(e.target.value); setHorIniSuggested(false); }} />
          </Field>
          <Field label="Horímetro final"><input type="number" min="0" step="0.1" value={horFim} onChange={e => setHorFim(e.target.value)} /></Field>
          <Field label="Quantidade colhida/produzida (opcional)"><input type="number" min="0" step="0.1" value={quantity} onChange={e => setQuantity(e.target.value)} /></Field>
          <Field label="Unidade"><select value={unit} onChange={e => setUnit(e.target.value)}>{UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}</select></Field>
        </div>
        {opTypeList.length === 0 && <div className="authError horimetroError">Nenhuma operação cadastrada ainda. Peça a um Administrador para cadastrar as operações em Cadastro antes de lançar.</div>}
        {!(machines && machines.length) && <div className="authError horimetroError">Nenhuma máquina cadastrada ainda. Peça a um Administrador para cadastrar máquinas em Cadastro antes de lançar operações.</div>}
        {machines && machines.length > 0 && farmId && machinesForFarm.length === 0 && <div className="authError horimetroError">Nenhuma máquina está atribuída a esta fazenda. Peça a um Administrador para ajustar em Cadastro → Máquinas.</div>}
        {areaError && <div className="authError horimetroError">{areaError}</div>}
        {horimetroError && <div className="authError horimetroError">{horimetroError}</div>}
        {!horimetroError && hoursComputed !== null && <div className="horimetroInfo">Horas trabalhadas (calculado): <strong>{fmtNum(hoursComputed, 2)} h</strong></div>}
        <Field label="Observações (opcional)"><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
        <div className="formFooter">
          {confirmMsg && <span className="confirmMsg">{confirmMsg}</span>}
          <button className="btnPrimary" type="button" onClick={handleRegister} disabled={!canSubmit}><Plus size={16} /> {busy ? "Salvando…" : "Registrar lançamento"}</button>
        </div>
      </div>
    </div>
  );
}
function Field({ label, children }) { return <label className="fieldLabel"><span>{label}</span>{children}</label>; }

/* ---------------- HISTÓRICO ---------------- */

function Historico({ farms, retiros, fields, operations, profiles, currentUser, opMeta, onDelete }) {
  const [farmId, setFarmId] = useState("all");
  const [retiroId, setRetiroId] = useState("all");
  const [opType, setOpType] = useState("all");
  const canDelete = currentUser.role === "gestor";
  const farmName = (id) => farms.find(f => f.id === id)?.name || "—";
  const retiroName = (id) => (retiros || []).find(r => r.id === id)?.name || "—";
  const fieldName = (id) => fields.find(f => f.id === id)?.name || "—";
  const operatorName = (id) => profiles.find(p => p.id === id)?.name || "—";
  const retiroOptions = farmId === "all" ? (retiros || []) : (retiros || []).filter(r => r.farm_id === farmId);
  const rows = operations
    .filter(o => farmId === "all" || o.farm_id === farmId)
    .filter(o => retiroId === "all" || o.retiro_id === retiroId)
    .filter(o => opType === "all" || o.op_type === opType)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  function handleExport() {
    const data = [...operations].sort((a, b) => (a.date < b.date ? 1 : -1)).map(o => {
      const meta = opMeta[o.op_type] || FALLBACK_OP_META;
      return {
        "Data": fmtDateBR(o.date),
        "Fazenda": farmName(o.farm_id),
        "Retiro": retiroName(o.retiro_id),
        "Talhão": fieldName(o.field_id),
        "Operação": meta.label,
        "Máquina": o.machine || "",
        "Área trabalhada (ha)": o.area_worked ?? "",
        "Horímetro inicial": o.horimetro_inicial ?? "",
        "Horímetro final": o.horimetro_final ?? "",
        "Horas": o.hours ?? "",
        "Quantidade": o.quantity ?? "",
        "Unidade": o.unit || "",
        "Operador": operatorName(o.operator_id),
        "Observações": o.notes || "",
      };
    });
    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = Object.keys(data[0] || {}).map(k => ({ wch: Math.max(12, k.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Lançamentos");
    XLSX.writeFile(wb, `lancamentos_${todayISO()}.xlsx`);
  }

  if (operations.length === 0) return <EmptyState title="Nenhum lançamento ainda" text="Os lançamentos registrados vão aparecer aqui." />;

  return (
    <div className="panel">
      <div className="panelHead">
        <h2>Histórico de lançamentos</h2>
        <div className="histFilters">
          <select value={farmId} onChange={e => { setFarmId(e.target.value); setRetiroId("all"); }}>
            <option value="all">Todas as fazendas</option>{farms.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select value={retiroId} onChange={e => setRetiroId(e.target.value)}>
            <option value="all">Todos os retiros</option>{retiroOptions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select value={opType} onChange={e => setOpType(e.target.value)}>
            <option value="all">Todas as operações</option>{Object.entries(opMeta).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
          <button className="btnPrimary exportBtn" type="button" onClick={handleExport}><Download size={14} /> Exportar Excel</button>
        </div>
      </div>
      <div className="tableWrap">
        <table>
          <thead><tr><th>Data</th><th>Fazenda</th><th>Retiro</th><th>Talhão</th><th>Operação</th><th>Máquina</th><th>Área</th><th>Horas</th><th>Rendimento</th><th>Operador</th>{canDelete && <th></th>}</tr></thead>
          <tbody>
            {rows.map(o => {
              const meta = opMeta[o.op_type] || FALLBACK_OP_META;
              return (
                <tr key={o.id} className={o._pending ? "pendingRow" : ""}>
                  <td>{fmtDateBR(o.date)}</td><td>{farmName(o.farm_id)}</td><td>{retiroName(o.retiro_id)}</td><td>{fieldName(o.field_id)}</td>
                  <td><span className="badge" style={{ "--badge-color": meta.color }}>{meta.label}</span></td>
                  <td>{o.machine || "—"}</td>
                  <td>{fmtNum(o.area_worked)} ha</td>
                  <td>{o.hours ? fmtNum(o.hours) + " h" : "—"}</td>
                  <td>{o.quantity ? `${fmtNum(o.quantity)} ${o.unit}` : "—"}</td>
                  <td>{o._pending ? "você (offline)" : operatorName(o.operator_id)}</td>
                  {canDelete && <td>{!o._pending && <button className="iconBtn" onClick={() => onDelete(o.id)} title="Excluir"><Trash2 size={14} /></button>}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="tableEmpty">Nenhum lançamento com esse filtro.</div>}
      </div>
    </div>
  );
}

/* ---------------- CADASTRO ---------------- */

function Cadastro({
  farms, retiros, fields, machines, opTypesRows, opMeta, users, currentUser,
  onAddFarm, onRemoveFarm, onAddRetiro, onRemoveRetiro, onRemoveField, onImportKml,
  onAddMachine, onRemoveMachine, onUpdateMachineFarm, onAddCustomOpType,
  onAddUser, onRemoveUser,
}) {
  const [newFarm, setNewFarm] = useState("");
  const [newRetiroFarmId, setNewRetiroFarmId] = useState(farms[0]?.id || "");
  const [newRetiroName, setNewRetiroName] = useState("");
  const [kmlFarmId, setKmlFarmId] = useState(farms[0]?.id || "");
  const [kmlRetiroId, setKmlRetiroId] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

  const [userName, setUserName] = useState("");
  const [userUsername, setUserUsername] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [userRole, setUserRole] = useState("operador");
  const [userFarmIds, setUserFarmIds] = useState([]);
  const [userError, setUserError] = useState("");
  const [userBusy, setUserBusy] = useState(false);

  const [newMachine, setNewMachine] = useState("");
  const [newOpTypeName, setNewOpTypeName] = useState("");
  const [opTypeError, setOpTypeError] = useState("");

  const retirosOfKmlFarm = retiros.filter(r => r.farm_id === kmlFarmId);

  useEffect(() => {
    if (!farms.find(f => f.id === kmlFarmId)) setKmlFarmId(farms[0]?.id || "");
    if (!farms.find(f => f.id === newRetiroFarmId)) setNewRetiroFarmId(farms[0]?.id || "");
    // eslint-disable-next-line
  }, [farms.length]);
  useEffect(() => {
    if (!retirosOfKmlFarm.find(r => r.id === kmlRetiroId)) setKmlRetiroId(retirosOfKmlFarm[0]?.id || "");
    // eslint-disable-next-line
  }, [kmlFarmId, retiros.length]);

  async function handleAddFarm() { if (!newFarm.trim()) return; await onAddFarm(newFarm.trim()); setNewFarm(""); }
  async function handleAddRetiro() { if (!newRetiroFarmId || !newRetiroName.trim()) return; await onAddRetiro(newRetiroFarmId, newRetiroName.trim()); setNewRetiroName(""); }

  async function handleKmlFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file || !kmlFarmId || !kmlRetiroId) return;
    setImporting(true); setImportMsg("");
    try {
      const text = await file.text();
      const parsed = parseKML(text);
      if (!parsed.length) setImportMsg("Nenhum polígono encontrado nesse arquivo KML.");
      else { const { created, updated } = await onImportKml(kmlFarmId, kmlRetiroId, parsed); setImportMsg(`${created} talhão(ões) criado(s) e ${updated} atualizado(s) a partir do KML.`); }
    } catch (err) { setImportMsg("Não foi possível ler esse arquivo. Confirme se é um KML válido."); }
    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function toggleUserFarm(farmId) {
    setUserFarmIds(prev => prev.includes(farmId) ? prev.filter(id => id !== farmId) : [...prev, farmId]);
  }
  async function handleAddUser() {
    setUserError("");
    if (!userName.trim() || !userUsername.trim() || !userPassword) { setUserError("Preencha todos os campos."); return; }
    if (userRole !== "gestor" && userFarmIds.length === 0) { setUserError("Selecione pelo menos uma fazenda para liberar o acesso desse usuário."); return; }
    const dup = users.some(u => (u.username || "").trim().toLowerCase() === userUsername.trim().toLowerCase());
    if (dup) { setUserError("Já existe um usuário com esse nome de acesso."); return; }
    setUserBusy(true);
    const err = await onAddUser({ name: userName.trim(), username: userUsername.trim(), password: userPassword, role: userRole, farmIds: userRole === "gestor" ? [] : userFarmIds });
    setUserBusy(false);
    if (err) { setUserError(err); return; }
    setUserName(""); setUserUsername(""); setUserPassword(""); setUserRole("operador"); setUserFarmIds([]);
  }
  async function handleRemoveUser(id) { const err = await onRemoveUser(id); if (err) setUserError(err); }

  async function handleAddCustomOpType() {
    const name = newOpTypeName.trim();
    if (!name) return;
    const err = await onAddCustomOpType(name);
    if (err) setOpTypeError(err); else { setOpTypeError(""); setNewOpTypeName(""); }
  }
  async function handleAddMachine() { if (!newMachine.trim()) return; await onAddMachine(newMachine.trim()); setNewMachine(""); }

  return (
    <div className="cadastroGrid">
      <section className="panel">
        <div className="panelHead"><h2>Fazendas</h2></div>
        <div className="inlineForm">
          <input type="text" placeholder="Nome da fazenda" value={newFarm} onChange={e => setNewFarm(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAddFarm()} />
          <button className="btnPrimary" type="button" onClick={handleAddFarm}><Plus size={15} /> Adicionar</button>
        </div>
        <ul className="listRows scrollList">
          {farms.map(f => <li key={f.id}><span>{f.name}</span><button className="iconBtn" onClick={() => onRemoveFarm(f.id)} title="Remover fazenda"><Trash2 size={14} /></button></li>)}
          {farms.length === 0 && <li className="emptyRow">Nenhuma fazenda cadastrada.</li>}
        </ul>
      </section>

      <section className="panel">
        <div className="panelHead"><h2>Retiros</h2></div>
        <div className="inlineForm">
          <select value={newRetiroFarmId} onChange={e => setNewRetiroFarmId(e.target.value)} disabled={!farms.length}>
            {farms.length === 0 && <option value="">Cadastre uma fazenda primeiro</option>}
            {farms.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <input type="text" placeholder="Nome do retiro" value={newRetiroName} onChange={e => setNewRetiroName(e.target.value)} disabled={!farms.length} onKeyDown={e => e.key === "Enter" && handleAddRetiro()} />
          <button className="btnPrimary" type="button" onClick={handleAddRetiro} disabled={!farms.length}><Plus size={15} /> Adicionar</button>
        </div>
        <ul className="listRows scrollList">
          {retiros.map(r => (
            <li key={r.id}><span>{r.name} <em>· {farms.find(x => x.id === r.farm_id)?.name || "—"}</em></span>
              <button className="iconBtn" onClick={() => onRemoveRetiro(r.id)} title="Remover retiro"><Trash2 size={14} /></button>
            </li>
          ))}
          {retiros.length === 0 && <li className="emptyRow">Nenhum retiro cadastrado.</li>}
        </ul>
      </section>

      <section className="panel">
        <div className="panelHead"><h2>Talhões</h2></div>
        <p className="kmlHint">Talhões só podem ser criados importando um arquivo KML com o polígono — assim todo talhão sempre tem sua área real delimitada no mapa.</p>
        <ul className="listRows scrollList">
          {[...fields].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")).map(f => (
            <li key={f.id}>
              <span>{f.name} <em>· {farms.find(x => x.id === f.farm_id)?.name || "—"} · {retiros.find(r => r.id === f.retiro_id)?.name || "sem retiro"} · {fmtNum(f.area_ha)} ha{f.coords ? " · polígono importado" : ""}</em></span>
              <button className="iconBtn" onClick={() => onRemoveField(f.id)} title="Remover talhão"><Trash2 size={14} /></button>
            </li>
          ))}
          {fields.length === 0 && <li className="emptyRow">Nenhum talhão cadastrado.</li>}
        </ul>
      </section>

      <section className="panel kmlPanel">
        <div className="panelHead"><h2>Importar polígonos (KML)</h2></div>
        <p className="kmlHint">Este é o único jeito de cadastrar talhões. Envie um arquivo .kml — cada Placemark vira um talhão dentro do retiro escolhido, já com a área calculada a partir do polígono.</p>
        <div className="kmlControls">
          <select value={kmlFarmId} onChange={e => setKmlFarmId(e.target.value)} disabled={!farms.length}>
            {farms.length === 0 && <option value="">Cadastre uma fazenda primeiro</option>}
            {farms.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select value={kmlRetiroId} onChange={e => setKmlRetiroId(e.target.value)} disabled={!retirosOfKmlFarm.length}>
            {retirosOfKmlFarm.length === 0 && <option value="">Cadastre um retiro primeiro</option>}
            {retirosOfKmlFarm.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <label className={"btnPrimary kmlUpload" + (!retirosOfKmlFarm.length || importing ? " disabled" : "")}>
            <UploadCloud size={15} /> {importing ? "Importando…" : "Escolher arquivo KML"}
            <input ref={fileInputRef} type="file" accept=".kml" onChange={handleKmlFile} disabled={!retirosOfKmlFarm.length || importing} hidden />
          </label>
        </div>
        {importMsg && <div className="kmlMsg">{importMsg}</div>}
      </section>

      <section className="panel">
        <div className="panelHead"><h2>Operações</h2></div>
        <p className="kmlHint">O sistema não vem com nenhuma operação pronta — cadastre abaixo os tipos que sua equipe usa (ex: Plantio, Colheita, Pulverização, Irrigação). Elas ficam disponíveis para lançamento e para os filtros do Painel.</p>
        {Object.keys(opMeta).length > 0 ? (
          <div className="opTypeRow scrollList">
            {Object.entries(opMeta).map(([key, meta]) => {
              const Icon = meta.icon;
              return <span key={key} className="opStamp opStampStatic" style={{ "--stamp-color": meta.color }}><Icon size={16} />{meta.label}</span>;
            })}
          </div>
        ) : (
          <p className="mapTip">Nenhuma operação cadastrada ainda.</p>
        )}
        <div className="inlineForm opTypeAddForm">
          <input type="text" placeholder="Nome da nova operação (ex: Irrigação)" value={newOpTypeName} onChange={e => setNewOpTypeName(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAddCustomOpType()} />
          <button className="btnPrimary" type="button" onClick={handleAddCustomOpType}><Plus size={15} /> Adicionar operação</button>
        </div>
        {opTypeError && <div className="authError userFormError">{opTypeError}</div>}
      </section>

      <section className="panel">
        <div className="panelHead"><h2>Máquinas</h2></div>
        <p className="kmlHint">Cadastre as máquinas e implementos usados na fazenda. No lançamento, o operador escolhe uma máquina desta lista — é obrigatório informar qual foi usada. Indique em qual fazenda cada máquina está atualmente; ela só aparece pra lançamento nessa fazenda (máquinas sem fazenda definida aparecem em qualquer uma).</p>
        <div className="inlineForm">
          <input type="text" placeholder="Nome da máquina (ex: Trator MF 4275)" value={newMachine} onChange={e => setNewMachine(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAddMachine()} />
          <button className="btnPrimary" type="button" onClick={handleAddMachine}><Plus size={15} /> Adicionar</button>
        </div>
        <ul className="listRows scrollList">
          {machines.map(m => (
            <li key={m.id} className="machineRow">
              <span className="machineName">{m.name}</span>
              <select className="machineFarmSelect" value={m.farm_id || ""} onChange={e => onUpdateMachineFarm(m.id, e.target.value || null)} title="Fazenda onde a máquina está atualmente">
                <option value="">Sem fazenda definida</option>
                {farms.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <button className="iconBtn" onClick={() => onRemoveMachine(m.id)} title="Remover máquina"><Trash2 size={14} /></button>
            </li>
          ))}
          {machines.length === 0 && <li className="emptyRow">Nenhuma máquina cadastrada.</li>}
        </ul>
      </section>

      <section className="panel kmlPanel">
        <div className="panelHead"><h2><Users size={15} style={{ marginRight: 6, verticalAlign: -2 }} />Usuários</h2></div>
        <p className="kmlHint">Cada usuário entra com seu próprio usuário e senha. Operadores lançam operações e veem os relatórios; Administradores cadastram tudo e veem os relatórios (de todas as fazendas); Supervisores só visualizam o Painel. Para Operador e Supervisor, escolha a quais fazendas o acesso será liberado.</p>
        <div className="inlineForm">
          <input type="text" placeholder="Nome completo" value={userName} onChange={e => setUserName(e.target.value)} />
          <input type="text" placeholder="Usuário" value={userUsername} onChange={e => setUserUsername(e.target.value)} />
          <input type="password" placeholder="Senha" value={userPassword} onChange={e => setUserPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAddUser()} />
          <select value={userRole} onChange={e => setUserRole(e.target.value)}>
            <option value="operador">Operador</option>
            <option value="gestor">Administrador</option>
            <option value="supervisor">Supervisor</option>
          </select>
          <button className="btnPrimary" type="button" onClick={handleAddUser} disabled={userBusy}><Plus size={15} /> {userBusy ? "Criando…" : "Adicionar"}</button>
        </div>
        {userRole !== "gestor" && (
          <div className="userFarmPicker">
            <span className="filterLabel">Fazendas liberadas para este usuário</span>
            <div className="userFarmChecks">
              {farms.length === 0 && <span className="emptyRow">Cadastre uma fazenda primeiro.</span>}
              {farms.map(f => (
                <label key={f.id} className="userFarmCheck">
                  <input type="checkbox" checked={userFarmIds.includes(f.id)} onChange={() => toggleUserFarm(f.id)} />
                  {f.name}
                </label>
              ))}
            </div>
          </div>
        )}
        {userError && <div className="authError userFormError">{userError}</div>}
        <ul className="listRows scrollList">
          {users.map(u => {
            const roleMeta = ROLE_META[u.role] || ROLE_META.operador;
            const farmNames = u.role !== "gestor" ? (u.farm_ids || []).map(id => farms.find(f => f.id === id)?.name).filter(Boolean) : [];
            return (
              <li key={u.id}>
                <span>
                  {u.name} <em>· @{u.username}</em>
                  <span className="rolePill inlinePill" style={{ "--role-color": roleMeta.color }}>{roleMeta.label}</span>
                  {u.id === currentUser.id && <span className="youTag">você</span>}
                  {u.role !== "gestor" && <em className="userFarmList"> · {farmNames.length ? farmNames.join(", ") : "nenhuma fazenda liberada"}</em>}
                </span>
                <button className="iconBtn" onClick={() => handleRemoveUser(u.id)} title="Remover usuário"><Trash2 size={14} /></button>
              </li>
            );
          })}
          {users.length === 0 && <li className="emptyRow">Nenhum usuário cadastrado.</li>}
        </ul>
      </section>
    </div>
  );
}

function EmptyState({ title, text, actionLabel, onAction }) {
  return (
    <div className="emptyState">
      <div className="emptyGlyph"><ClipboardList size={22} /></div>
      <h3>{title}</h3><p>{text}</p>
      {actionLabel && <button className="btnPrimary" onClick={onAction}>{actionLabel} <ChevronRight size={15} /></button>}
    </div>
  );
}

function Style() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Bitter:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap');
      * { box-sizing: border-box; }
      html, body, #root { height: 100%; margin: 0; }
      .app {
        --soil-dark: #EAEFE6; --soil-mid: #DEE6DA; --paper: #EDE6D6; --paper-dim: #E2D8C1;
        --ink: #241B14; --ink-soft: #6b5c47; --cream: #F6F0E4;
        --green: #4F7942; --gold: #C9A227; --blue: #3E7C8C; --brown: #8B5E34; --rust: #A85C36;
        --line: rgba(27,67,50,0.12); --line-dark: rgba(36,27,20,0.14);
        font-family: 'Inter', sans-serif; background: var(--soil-dark); color: #1B4332;
        min-height: 100vh; display: flex; flex-direction: column;
      }
      .loadingWrap { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 60px 20px; color: #1B4332; opacity: 0.75; font-size: 14px; flex: 1; }
      .spin { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }

      .offlineBanner { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: rgba(201,162,39,0.22); color: #6B4E12; font-size: 12px; padding: 8px 20px; border-bottom: 1px solid var(--line); }
      .offlineBanner.offline { background: rgba(168,92,54,0.22); color: #6B3419; }
      .offlineSyncBtn { margin-left: 6px; background: rgba(0,0,0,0.08); border: 1px solid rgba(0,0,0,0.15); color: inherit; font-size: 11px; padding: 3px 9px; border-radius: 5px; cursor: pointer; }
      .offlineSyncBtn:hover { background: rgba(0,0,0,0.14); }
      .pendingRow { opacity: 0.7; font-style: italic; }

      .authWrap { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 20px 32px; background: #EAEFE6; }
      .authBrandImg { width: 80px; height: 80px; border-radius: 20px; object-fit: cover; display: block; box-shadow: 0 6px 16px rgba(36,27,20,0.18); }
      .authTitle { font-family: 'Bitter', serif; font-weight: 700; font-size: 24px; color: #1B4332; margin: 16px 0 4px; text-align: center; }
      .authSub { font-size: 13px; color: #66756A; margin: 0 0 26px; text-align: center; }
      .authCard { background: #FFFFFF; border-radius: 14px; padding: 28px 26px; width: 100%; max-width: 360px; text-align: center; box-shadow: 0 8px 24px rgba(27,67,50,0.08); }
      .authForm { display: flex; flex-direction: column; gap: 12px; text-align: left; }
      .authCard .fieldLabel span { color: #4A5A4C; }
      .authCard .fieldLabel input { background: #FBFCFA; border: 1px solid #D9E0D6; color: #1B4332; }
      .authCard .fieldLabel input:focus { border-color: #1B4332; }
      .authError { font-size: 11.5px; color: var(--rust); background: rgba(168,92,54,0.12); padding: 7px 9px; border-radius: 6px; }
      .authSubmit { justify-content: center; margin-top: 4px; background: #1B4332; }
      .authSubmit:hover { background: #163829; }
      .authSwitch { margin-top: 14px; background: none; border: none; color: #7C8A7E; font-size: 11px; text-decoration: underline; cursor: pointer; font-family: 'Inter', sans-serif; }
      .authFooterWrap { margin-top: 44px; text-align: center; }
      .authFooterLabel { font-size: 10.5px; color: #92A08F; margin-bottom: 8px; }
      .authFooterLogo { height: 34px; width: auto; opacity: 0.9; }

      .header { background: var(--soil-dark); padding: 18px 20px 0; border-bottom: 1px solid var(--line); }
      .headerTop { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
      .headerRight { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .brand { display: flex; align-items: center; gap: 10px; }
      .brandMark { width: 34px; height: 34px; border-radius: 7px; background: var(--green); display: flex; align-items: center; justify-content: center; color: var(--cream); flex-shrink: 0; }
      .brandTitle { font-family: 'Bitter', serif; font-weight: 700; font-size: 17px; letter-spacing: 0.2px; color: #1B4332; }
      .brandSub { font-size: 11.5px; color: rgba(27,67,50,0.55); margin-top: 1px; }
      .userBadge { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #1B4332; }
      .userName { font-weight: 500; }
      .rolePill { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; padding: 2px 7px; border-radius: 20px; background: color-mix(in srgb, var(--role-color) 30%, transparent); color: var(--role-color); }
      .rolePill.inlinePill { margin-left: 6px; }
      .logoutBtn { color: rgba(27,67,50,0.6); }
      .logoutBtn:hover { color: #1B4332; background: rgba(27,67,50,0.08); }
      .youTag { font-size: 9.5px; color: var(--ink-soft); margin-left: 6px; text-transform: uppercase; letter-spacing: 0.3px; }

      .tabs { display: flex; gap: 4px; }
      .tabBtn { display: flex; align-items: center; gap: 6px; padding: 9px 14px; font-size: 12.5px; color: rgba(27,67,50,0.55); background: transparent; border: none; border-bottom: 2px solid transparent; cursor: pointer; font-family: 'Inter', sans-serif; font-weight: 500; }
      .tabBtn:hover { color: #1B4332; }
      .tabBtn.active { color: #1B4332; border-bottom-color: var(--gold); }

      .content { flex: 1; overflow-y: auto; padding: 20px; background: var(--soil-dark); max-width: 1100px; margin: 0 auto; width: 100%; }
      .saveError { background: rgba(168,92,54,0.18); color: #6B3419; font-size: 12px; padding: 8px 20px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; }
      .dismissErr { background: none; border: none; color: inherit; cursor: pointer; font-size: 14px; }

      .kpiGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 16px; }
      .kpiCard { background: var(--paper); border-radius: 8px; padding: 13px 14px; position: relative; border-top: 3px solid var(--accent); }
      .kpiIcon { color: var(--accent); margin-bottom: 8px; }
      .kpiLabel { font-size: 11px; color: var(--ink-soft); margin-bottom: 4px; }
      .kpiValue { font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: 21px; color: var(--ink); line-height: 1; }
      .kpiUnit { font-size: 11px; color: var(--ink-soft); margin-left: 4px; font-family: 'Inter', sans-serif; }

      .panel { background: var(--paper); border-radius: 8px; padding: 16px; margin-bottom: 14px; }
      .panelHead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
      .panelHead h2 { font-family: 'Bitter', serif; font-size: 15px; color: var(--ink); font-weight: 600; margin: 0; display: flex; align-items: center; }
      .panelHint { font-size: 10.5px; color: var(--ink-soft); }
      .chartWrap { margin: 0 -4px; }

      .filterPanel { padding-bottom: 12px; }
      .filterClear { background: none; border: none; color: var(--ink-soft); font-size: 11px; text-decoration: underline; cursor: pointer; font-family: 'Inter', sans-serif; }
      .chartModeRow { display: flex; gap: 4px; }
      .chartModeBtn { font-size: 11px; font-weight: 500; padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(36,27,20,0.15); background: var(--cream); color: var(--ink-soft); cursor: pointer; font-family: 'Inter', sans-serif; }
      .chartModeBtn.active { background: var(--green); color: var(--cream); border-color: var(--green); font-weight: 600; }
      .filterRow { display: flex; flex-wrap: wrap; gap: 16px 24px; }
      .filterGroup { display: flex; flex-direction: column; gap: 6px; }
      .filterLabel { font-size: 10.5px; font-weight: 600; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.3px; }
      .filterGroup select { font-size: 12.5px; padding: 7px 9px; border-radius: 6px; border: 1px solid rgba(36,27,20,0.15); background: var(--cream); color: var(--ink); }
      .filterDates { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--ink-soft); }
      .filterDates input { font-size: 12.5px; padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(36,27,20,0.15); background: var(--cream); color: var(--ink); }
      .legend { display: flex; flex-wrap: wrap; gap: 10px 14px; margin-bottom: 12px; }
      .legendItem { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--ink-soft); }
      .legendItem i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }

      .farmMapGroup { margin-bottom: 16px; }
      .farmMapGroup:last-child { margin-bottom: 0; }
      .farmMapLabel { font-size: 11.5px; font-weight: 600; color: var(--ink); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.7; }
      .subGroupLabel { font-size: 10.5px; color: var(--ink-soft); margin: 8px 0 6px; }

      .farmSatWrap { position: relative; border-radius: 8px; overflow: hidden; border: 1px solid rgba(36,27,20,0.15); box-shadow: 0 3px 10px rgba(36,27,20,0.18), inset 0 0 0 1px rgba(255,255,255,0.04); }
      .mapControls { position: absolute; top: 8px; left: 8px; z-index: 2; display: flex; gap: 4px; background: rgba(20,16,10,0.55); backdrop-filter: blur(3px); padding: 4px; border-radius: 7px; box-shadow: 0 2px 6px rgba(0,0,0,0.25); }
      .mapToggleBtn { font-size: 10px; font-weight: 500; color: rgba(255,255,255,0.75); background: transparent; border: 1px solid rgba(255,255,255,0.28); border-radius: 5px; padding: 3px 8px; cursor: pointer; font-family: 'Inter', sans-serif; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease; }
      .mapToggleBtn:hover { border-color: rgba(255,255,255,0.5); color: #fff; }
      .mapToggleBtn.active { background: rgba(255,255,255,0.22); color: #fff; border-color: rgba(255,255,255,0.55); font-weight: 600; }
      .mapZoomControls { position: absolute; top: 8px; right: 8px; z-index: 2; display: flex; flex-direction: column; gap: 4px; background: rgba(20,16,10,0.55); backdrop-filter: blur(3px); padding: 4px; border-radius: 7px; box-shadow: 0 2px 6px rgba(0,0,0,0.25); }
      .mapZoomBtn { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; background: transparent; color: rgba(255,255,255,0.85); border: none; border-radius: 5px; cursor: pointer; padding: 0; transition: background 0.15s ease, color 0.15s ease; }
      .mapZoomBtn:hover { background: rgba(255,255,255,0.16); color: #fff; }
      .farmSvgMap { width: 100%; height: auto; display: block; background: #38301f; }
      .farmSvgMap.draggable { cursor: grab; touch-action: none; }
      .farmSvgMap.dragging { cursor: grabbing; user-select: none; touch-action: none; }
      .mapFieldName { font-family: 'Inter', sans-serif; font-size: 11px; font-weight: 700; fill: #ffffff; paint-order: stroke; stroke: rgba(0,0,0,0.75); stroke-width: 3px; stroke-linejoin: round; }
      .mapFieldSub { font-family: 'IBM Plex Mono', monospace; font-size: 9px; fill: #ffffff; paint-order: stroke; stroke: rgba(0,0,0,0.75); stroke-width: 3px; stroke-linejoin: round; }
      .mapAttribution { position: absolute; right: 8px; bottom: 6px; font-size: 8px; color: rgba(255,255,255,0.75); background: rgba(20,16,10,0.45); backdrop-filter: blur(2px); padding: 2px 6px; border-radius: 4px; pointer-events: none; }
      .mapTip { font-size: 11.5px; color: var(--ink-soft); margin: 4px 0 0; }

      .fieldGrid { display: flex; flex-wrap: wrap; gap: 8px; }
      .fieldTile { position: relative; overflow: hidden; border: 1px solid; border-radius: 6px; padding: 9px 10px; min-width: 96px; flex-grow: 1; }
      .fieldTileRows { position: absolute; inset: 0; opacity: 0.5; pointer-events: none; background: repeating-linear-gradient(115deg, rgba(36,27,20,0.05) 0px, rgba(36,27,20,0.05) 2px, transparent 2px, transparent 9px); }
      .fieldTileTop { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--ink); position: relative; }
      .fieldTileArea { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--ink-soft); margin: 4px 0 7px; position: relative; }
      .fieldTileBarWrap { height: 5px; background: rgba(36,27,20,0.1); border-radius: 3px; overflow: hidden; position: relative; }
      .fieldTileBar { height: 100%; border-radius: 3px; }
      .fieldTilePct { font-size: 9.5px; color: var(--ink-soft); margin-top: 4px; position: relative; }

      .quickAdd { display: flex; justify-content: flex-end; }
      .btnPrimary { display: inline-flex; align-items: center; gap: 6px; background: var(--green); color: var(--cream); border: none; border-radius: 7px; padding: 9px 15px; font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: 'Inter', sans-serif; white-space: nowrap; }
      .btnPrimary:hover { filter: brightness(1.08); }
      .btnPrimary:disabled, .btnPrimary.disabled { opacity: 0.5; cursor: not-allowed; }
      .kmlUpload { position: relative; }

      .formPanel { max-width: 720px; }
      .opTypeRow { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
      .opStamp { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 7px; border: 1.5px solid rgba(36,27,20,0.15); background: transparent; color: var(--ink); font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; }
      .opStampStatic { cursor: default; border-color: var(--stamp-color); background: color-mix(in srgb, var(--stamp-color) 14%, transparent); font-weight: 600; }
      .opTypeAddForm { margin-top: 4px; margin-bottom: 0; }

      .formGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 12px; }
      .fieldLabel { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; color: var(--ink-soft); font-weight: 500; }
      .fieldLabel input, .fieldLabel select, .fieldLabel textarea { font-family: 'Inter', sans-serif; font-size: 13px; color: var(--ink); background: var(--cream); border: 1px solid rgba(36,27,20,0.15); border-radius: 6px; padding: 8px 9px; outline: none; }
      .fieldLabel input:focus, .fieldLabel select:focus, .fieldLabel textarea:focus { border-color: var(--green); }
      .formFooter { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 8px; }
      .confirmMsg { font-size: 12px; color: var(--green); font-weight: 600; }
      .horimetroInfo { font-size: 12px; color: var(--ink-soft); margin: -4px 0 12px; }
      .horimetroError { margin: -4px 0 12px; }

      .tableWrap { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      thead th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.3px; color: var(--ink-soft); padding: 6px 8px; border-bottom: 1px solid rgba(36,27,20,0.15); }
      tbody td { padding: 8px; border-bottom: 1px solid rgba(36,27,20,0.08); color: var(--ink); }
      .badge { padding: 3px 8px; border-radius: 20px; font-size: 10.5px; font-weight: 600; background: color-mix(in srgb, var(--badge-color) 18%, white); color: color-mix(in srgb, var(--badge-color) 70%, black); }
      .iconBtn { background: transparent; border: none; color: var(--ink-soft); cursor: pointer; padding: 4px; border-radius: 4px; }
      .iconBtn:hover { color: var(--rust); background: rgba(168,92,54,0.1); }
      .tableEmpty { padding: 20px; text-align: center; color: var(--ink-soft); font-size: 12.5px; }
      .histFilters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .exportBtn { padding: 7px 12px; font-size: 11.5px; }
      .histFilters select { font-size: 11.5px; padding: 5px 7px; border-radius: 6px; border: 1px solid rgba(36,27,20,0.15); background: var(--cream); color: var(--ink); }

      .cadastroGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; align-items: start; }
      .kmlPanel { grid-column: 1 / -1; }
      .kmlHint { font-size: 11.5px; color: var(--ink-soft); margin: 0 0 12px; max-width: 640px; }
      .kmlControls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .kmlControls select { font-size: 12.5px; padding: 8px 9px; border-radius: 6px; border: 1px solid rgba(36,27,20,0.15); background: var(--cream); color: var(--ink); }
      .kmlMsg { margin-top: 10px; font-size: 12px; color: var(--ink); background: rgba(79,121,66,0.12); border-radius: 6px; padding: 8px 10px; }
      .userFormError { margin-bottom: 10px; }
      .userFarmPicker { margin: 2px 0 12px; }
      .userFarmChecks { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 6px; }
      .userFarmCheck { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink); background: var(--cream); padding: 5px 9px; border-radius: 6px; cursor: pointer; }
      .userFarmList { font-style: normal; color: var(--ink-soft); }

      .inlineForm { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
      .inlineForm input, .inlineForm select { font-family: 'Inter', sans-serif; font-size: 12.5px; padding: 8px 9px; border-radius: 6px; border: 1px solid rgba(36,27,20,0.15); background: var(--cream); color: var(--ink); flex: 1; min-width: 110px; }
      .listRows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .scrollList { max-height: 260px; overflow-y: auto; padding-right: 4px; }
      .listRows li { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: var(--cream); border-radius: 6px; font-size: 12.5px; color: var(--ink); }
      .machineRow { gap: 8px; flex-wrap: wrap; }
      .machineName { flex: 1; min-width: 100px; }
      .machineFarmSelect { font-size: 11.5px; padding: 5px 7px; border-radius: 5px; border: 1px solid rgba(36,27,20,0.15); background: #fff; color: var(--ink); max-width: 180px; }
      .listRows li em { font-style: normal; color: var(--ink-soft); }
      .emptyRow { color: var(--ink-soft) !important; justify-content: center !important; }

      .emptyState { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 60px 24px; background: var(--paper); border-radius: 8px; color: var(--ink); }
      .emptyGlyph { width: 42px; height: 42px; border-radius: 50%; background: rgba(79,121,66,0.15); color: var(--green); display: flex; align-items: center; justify-content: center; margin-bottom: 4px; }
      .emptyState h3 { font-family: 'Bitter', serif; font-size: 16px; margin: 0; }
      .emptyState p { font-size: 12.5px; color: var(--ink-soft); max-width: 360px; margin: 0 0 6px; }

      .mapMobileNotice { font-size: 11.5px; color: var(--ink-soft); text-align: center; padding: 4px 10px 0; }

      @media (max-width: 480px) {
        .kpiGrid { grid-template-columns: repeat(2, 1fr); }
        .brandSub { display: none; }
      }
    `}</style>
  );
}
