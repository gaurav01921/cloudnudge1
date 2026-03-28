import React, { useState, useEffect, useMemo } from "react";
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Dot, Legend
} from "recharts";
import { 
  AlertTriangle, CheckCircle, TrendingUp, DollarSign, Zap, 
  ArrowRight, ShieldAlert, History, Activity, Info, X, Cloud, Server, Database
} from "lucide-react";
import { format } from "date-fns";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { motion, AnimatePresence } from "motion/react";

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface CostData {
  id: number;
  date: string;
  service: string;
  cost: number;
  cpu_utilization: number;
  memory_utilization: number;
}

interface Anomaly extends CostData {
  anomaly_score: number;
  is_anomaly: boolean;
  projected_waste_monthly: number;
  confidence: number;
  recommendation: string;
  idle_cost: number;
  efficiency_score: number;
}

interface AuditLog {
  id: number;
  timestamp: string;
  service: string;
  action: string;
  savings_monthly: number;
  before_cost: number;
  after_cost: number;
  efficiency_score: number;
}

export default function App() {
  const [isOnboarded, setIsOnboarded] = useState(false);
  const [costData, setCostData] = useState<CostData[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [auditLog, setAuditLog] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAnomaly, setSelectedAnomaly] = useState<Anomaly | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [remediating, setRemediating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  const fetchData = async (isSilent = false) => {
    try {
      if (!isSilent) setLoading(true);
      const [costsRes, anomaliesRes, auditRes] = await Promise.all([
        fetch("/api/cost_data"),
        fetch("/api/run_ml_anomaly_detection"),
        fetch("/api/audit_log")
      ]);
      
      if (!costsRes.ok || !anomaliesRes.ok || !auditRes.ok) {
        throw new Error("One or more API requests failed");
      }

      const costs = await costsRes.json();
      const detectedAnomalies = await anomaliesRes.json();
      const audit = await auditRes.json();

      setCostData(costs);
      setAnomalies(detectedAnomalies);
      setAuditLog(audit);
      setLastUpdated(new Date());
    } catch (err) {
      console.error("Error fetching data:", err);
    } finally {
      if (!isSilent) setLoading(false);
    }
  };

  useEffect(() => {
    if (isOnboarded) {
      fetchData();
      const interval = setInterval(() => fetchData(true), 10000);
      return () => clearInterval(interval);
    }
  }, [isOnboarded]);

  const stats = useMemo(() => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const last30DaysCost = costData
      .filter(d => new Date(d.date) >= thirtyDaysAgo)
      .reduce((acc, curr) => acc + curr.cost, 0);

    const totalSavings = auditLog.reduce((acc, curr) => acc + curr.savings_monthly, 0);
    
    // Use average efficiency score from anomalies if they exist, otherwise baseline
    const avgEfficiency = anomalies.length > 0
      ? Math.round(anomalies.reduce((acc, curr) => acc + curr.efficiency_score, 0) / anomalies.length)
      : 82; // Default baseline

    return {
      spend30d: last30DaysCost,
      savings: totalSavings,
      efficiency: avgEfficiency,
      anomalyCount: anomalies.length
    };
  }, [costData, auditLog, anomalies]);

  const chartData = useMemo(() => {
    // Group by date
    const grouped = costData.reduce((acc: any, curr) => {
      if (!acc[curr.date]) acc[curr.date] = { date: curr.date, total: 0, isAnomaly: false };
      acc[curr.date].total += curr.cost;
      if (anomalies.some(a => a.date === curr.date)) {
        acc[curr.date].isAnomaly = true;
      }
      return acc;
    }, {});
    return Object.values(grouped).sort((a: any, b: any) => a.date.localeCompare(b.date));
  }, [costData, anomalies]);

  const handleRemediate = async () => {
    if (!selectedAnomaly) return;

    try {
      setRemediating(true);
      setError(null);
      const res = await fetch("/api/remediate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: selectedAnomaly.service,
          action: selectedAnomaly.recommendation,
          savings_monthly: selectedAnomaly.projected_waste_monthly
        })
      });

      const data = await res.json();

      if (res.ok) {
        setIsModalOpen(false);
        setSelectedAnomaly(null);
        fetchData(); // Refresh data
      } else {
        setError(data.error || "Remediation failed");
      }
    } catch (err) {
      console.error("Remediation failed:", err);
      setError("Network error. Please try again.");
    } finally {
      setRemediating(false);
    }
  };

  if (!isOnboarded) {
    return <Onboarding onComplete={() => setIsOnboarded(true)} />;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0A0A0B] text-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-6">
          <Activity className="w-12 h-12 text-blue-500 animate-pulse" />
          <div className="text-center">
            <p className="text-xl font-medium tracking-tight">Initializing CloudCost IQ...</p>
            <p className="text-sm text-white/40 mt-2">Connecting to ML Engine & SQLite Database</p>
          </div>
          <button 
            onClick={() => fetchData()}
            className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-xs hover:bg-white/10 transition-colors"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans selection:bg-blue-500/30">
      {/* Header */}
      <header className="border-b border-slate-900 bg-slate-950/80 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-600/20">
              <Zap className="w-5 h-5 text-white fill-current" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">CloudCost <span className="text-blue-500">IQ</span></h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-[10px] font-mono text-slate-500 hidden sm:block">
              LAST UPDATED: {format(lastUpdated, "HH:mm:ss")}
            </div>
            <div className="px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-[10px] font-bold text-blue-400 flex items-center gap-2">
              <Zap className="w-3 h-3 fill-current" />
              AUTO-PILOT ACTIVE (90% CONFIDENCE)
            </div>
            <div className="px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs font-medium text-slate-400 flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              Live Monitoring Active
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <KpiCard 
            title="30-Day Spend" 
            value={`$${stats.spend30d.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
            icon={<DollarSign className="w-5 h-5 text-blue-400" />}
            trend="+2.4% vs last month"
            trendColor="text-red-400"
            status="STABLE"
          />
          <KpiCard 
            title="Savings Realized" 
            value={`$${stats.savings.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
            icon={<CheckCircle className="w-5 h-5 text-green-400" />}
            trend="Total optimized"
            status="STABLE"
          />
          <KpiCard 
            title="Efficiency Score" 
            value={`${stats.efficiency}%`}
            icon={<TrendingUp className="w-5 h-5 text-purple-400" />}
            trend="Resource utilization"
            status="STABLE"
          />
          <KpiCard 
            title="Active Anomalies" 
            value={stats.anomalyCount.toString()}
            icon={<AlertTriangle className="w-5 h-5 text-red-400" />}
            trend="Requires attention"
            status="CRITICAL"
            isCritical={true}
          />
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Chart Section */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
              <div className="flex items-center justify-between mb-8">
                <div>
                  <h2 className="text-lg font-semibold text-white">Cost Trend Analysis</h2>
                  <p className="text-sm text-slate-400">90-day historical billing with ML anomaly markers</p>
                </div>
                <div className="flex items-center gap-4 text-xs font-medium">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-blue-500" />
                    <span className="text-slate-400">Baseline</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-500 border-2 border-slate-200" />
                    <span className="text-slate-400">Anomaly</span>
                  </div>
                </div>
              </div>
              
              <div className="h-[350px] w-full" key={lastUpdated.getTime()}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.4}/>
                        <stop offset="95%" stopColor="#3B82F6" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
                    <XAxis 
                      dataKey="date" 
                      stroke="#ffffff20" 
                      fontSize={11} 
                      tickFormatter={(val) => format(new Date(val), "MMM d")}
                      minTickGap={30}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis 
                      stroke="#ffffff20" 
                      fontSize={11} 
                      tickFormatter={(val) => `$${val}`}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#0F172A', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                      itemStyle={{ color: '#F1F5F9' }}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="total" 
                      stroke="#3B82F6" 
                      strokeWidth={3}
                      fillOpacity={1} 
                      fill="url(#colorTotal)" 
                      dot={(props: any) => {
                        const { cx, cy, payload } = props;
                        if (payload.isAnomaly) {
                          return (
                            <circle 
                              cx={cx} 
                              cy={cy} 
                              r={6} 
                              fill="#EF4444" 
                              stroke="#E2E8F0" 
                              strokeWidth={3} 
                              className="drop-shadow-[0_0_8px_rgba(239,68,68,0.5)]"
                            />
                          );
                        }
                        return null;
                      }}
                      activeDot={{ r: 6, strokeWidth: 0 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Audit Log Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
              <div className="p-6 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <History className="w-5 h-5 text-blue-400" />
                  <h2 className="text-lg font-semibold text-white">Remediation Audit Log</h2>
                </div>
                <span className="text-xs text-slate-500 font-mono uppercase tracking-wider">System Ledger</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-950/50 text-slate-500 font-medium uppercase text-[10px] tracking-widest">
                    <tr>
                      <th className="px-6 py-4">Timestamp</th>
                      <th className="px-6 py-4">Service</th>
                      <th className="px-6 py-4">Action Taken</th>
                      <th className="px-6 py-4">Efficiency</th>
                      <th className="px-6 py-4 text-right">Monthly Savings</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {auditLog.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-6 py-12 text-center text-slate-600">
                          No remediation actions recorded yet.
                        </td>
                      </tr>
                    ) : (
                      auditLog.map((log) => (
                        <tr key={log.id} className="hover:bg-slate-800/50 transition-colors">
                          <td className="px-6 py-4 text-slate-400">
                            {format(new Date(log.timestamp), "MMM d, HH:mm")}
                          </td>
                          <td className="px-6 py-4">
                            <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 text-xs font-medium border border-blue-500/20">
                              {log.service}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              {log.action.startsWith("[AUTO]") ? (
                                <>
                                  <span className="px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 text-[10px] font-bold border border-purple-500/30 flex items-center gap-1">
                                    <Activity className="w-3 h-3" />
                                    AUTO
                                  </span>
                                  <span className="text-slate-300">{log.action.replace("[AUTO] ", "")}</span>
                                </>
                              ) : (
                                <span className="text-slate-300">{log.action}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <div className="w-12 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                <div 
                                  className="h-full bg-purple-500" 
                                  style={{ width: `${log.efficiency_score}%` }} 
                                />
                              </div>
                              <span className="text-xs text-slate-500">{log.efficiency_score}%</span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right font-mono text-green-400 font-medium">
                            +${log.savings_monthly.toFixed(2)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Action Feed Section */}
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl h-full">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-5 h-5 text-red-400" />
                  <h2 className="text-lg font-semibold text-white">ML Insights</h2>
                </div>
                <span className="px-2 py-1 rounded bg-red-500/10 text-red-400 text-[10px] font-bold uppercase tracking-tighter">
                  {anomalies.length} Active
                </span>
              </div>

              <div className="space-y-4">
                {anomalies.length === 0 ? (
                  <div className="py-12 flex flex-col items-center justify-center text-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center">
                      <CheckCircle className="w-6 h-6 text-green-500" />
                    </div>
                    <div>
                      <p className="text-white font-medium">System Optimized</p>
                      <p className="text-sm text-slate-500">No active anomalies detected.</p>
                    </div>
                  </div>
                ) : (
                  anomalies.map((anomaly) => (
                    <div 
                      key={anomaly.id} 
                      onClick={() => {
                        setSelectedAnomaly(anomaly);
                        setIsModalOpen(true);
                      }}
                      className="group p-4 rounded-xl bg-slate-950/50 border border-slate-800 hover:border-red-500/30 transition-all duration-300 cursor-pointer"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h3 className="font-bold text-white flex items-center gap-2">
                            {anomaly.service}
                            <span className="text-[10px] font-normal px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                              {anomaly.date}
                            </span>
                          </h3>
                          <div className="flex items-center gap-3 mt-1">
                            <p className="text-[10px] text-slate-500">CPU: {Math.round(anomaly.cpu_utilization * 100)}%</p>
                            <p className="text-[10px] text-slate-500">MEM: {Math.round(anomaly.memory_utilization * 100)}%</p>
                          </div>
                          <p className="text-xs text-slate-500 mt-1 line-clamp-1">{anomaly.recommendation}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs font-bold text-red-400">-{Math.round(anomaly.anomaly_score * 100)}%</p>
                          <p className="text-[10px] text-slate-600 uppercase">Confidence</p>
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-800">
                        <div>
                          <p className="text-[10px] text-slate-600 uppercase font-bold">Projected Waste</p>
                          <p className="text-sm font-mono text-red-400 font-bold">${anomaly.projected_waste_monthly.toFixed(0)}/mo</p>
                        </div>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedAnomaly(anomaly);
                            setIsModalOpen(true);
                          }}
                          className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-colors flex items-center gap-2 group-hover:translate-x-1"
                        >
                          Optimize Now
                          <ArrowRight className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              
              <div className="mt-8 p-4 rounded-xl bg-blue-500/5 border border-blue-500/10 flex gap-3">
                <Info className="w-5 h-5 text-blue-400 shrink-0" />
                <p className="text-[11px] text-blue-300/60 leading-relaxed">
                  Isolation Forest model is trained on 90-day rolling window. 
                  Threshold set to 0.65 for high-precision detection.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Remediation Modal */}
      {isModalOpen && selectedAnomaly && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setIsModalOpen(false)} />
          <div className="relative bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-8">
              <div className="flex items-center justify-between mb-6">
                <div className="w-12 h-12 rounded-2xl bg-red-500/10 flex items-center justify-center">
                  <ShieldAlert className="w-6 h-6 text-red-500" />
                </div>
                <button onClick={() => setIsModalOpen(false)} className="text-slate-500 hover:text-white transition-colors">
                  <X className="w-6 h-6" />
                </button>
              </div>
              
              <h2 className="text-2xl font-bold text-white mb-2">Confirm Remediation</h2>
              <p className="text-slate-400 text-sm leading-relaxed">
                You are about to execute an auto-remediation action for <span className="text-white font-medium">{selectedAnomaly.service}</span>. 
                This will trigger the following cloud operation:
              </p>
              
              {error && (
                <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-3 text-red-400 text-xs">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              )}

              <div className="my-6 p-4 rounded-2xl bg-slate-950/50 border border-slate-800 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-slate-500">Action</span>
                  <span className="text-xs font-bold text-blue-400">{selectedAnomaly.recommendation}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-slate-500">Projected Savings</span>
                  <span className="text-xs font-bold text-green-400 font-mono">+${selectedAnomaly.projected_waste_monthly.toFixed(2)}/mo</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-slate-500">Current Idle Cost</span>
                  <span className="text-xs font-bold text-red-400 font-mono">${selectedAnomaly.idle_cost.toFixed(2)}/day</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-slate-500">ML Confidence</span>
                  <span className="text-xs font-bold text-white">{selectedAnomaly.confidence}%</span>
                </div>
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={() => {
                    setIsModalOpen(false);
                    setError(null);
                  }}
                  disabled={remediating}
                  className="flex-1 px-6 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleRemediate}
                  disabled={remediating}
                  className="flex-1 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold transition-all shadow-lg shadow-blue-600/20 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {remediating ? (
                    <>
                      <Activity className="w-4 h-4 animate-spin" />
                      Executing...
                    </>
                  ) : "Execute Action"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = () => {
    setIsConnecting(true);
    setTimeout(() => {
      onComplete();
    }, 2000);
  };

  const providers = [
    { id: 'aws', name: 'AWS', icon: <Cloud className="w-6 h-6" />, color: 'text-orange-400' },
    { id: 'azure', name: 'Azure', icon: <Server className="w-6 h-6" />, color: 'text-blue-400' },
    { id: 'gcp', name: 'Google Cloud', icon: <Database className="w-6 h-6" />, color: 'text-red-400' },
  ];

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-3xl p-8 md:p-12 shadow-2xl"
      >
        <div className="flex flex-col items-center text-center mb-10">
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-xl shadow-blue-600/20 mb-6">
            <Zap className="w-10 h-10 text-white fill-current" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-3">Get started today to optimize your cloud costs</h1>
          <p className="text-slate-400 max-w-md">Connect your cloud infrastructure to start detecting anomalies and realizing savings in minutes.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
          {providers.map((provider) => (
            <button
              key={provider.id}
              onClick={() => setSelectedProvider(provider.id)}
              className={cn(
                "flex flex-col items-center gap-4 p-6 rounded-2xl border transition-all duration-300",
                selectedProvider === provider.id 
                  ? "bg-blue-600/10 border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.1)]" 
                  : "bg-slate-950/50 border-slate-800 hover:border-slate-700"
              )}
            >
              <div className={cn("w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800", provider.color)}>
                {provider.icon}
              </div>
              <span className="font-bold text-white">{provider.name}</span>
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {selectedProvider === 'aws' && (
            <motion.div 
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-10 p-6 rounded-2xl bg-slate-950/50 border border-slate-800"
            >
              <p className="text-slate-300 text-sm leading-relaxed mb-6">
                Would you like to set up an AWS CloudFormation stack to link your AWS account? This provides the most secure, read-only access to your billing data.
              </p>
              <div className="flex gap-4">
                <button 
                  onClick={handleConnect}
                  disabled={isConnecting}
                  className="flex-1 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold transition-all shadow-lg shadow-blue-600/20 flex items-center justify-center gap-2"
                >
                  {isConnecting ? (
                    <>
                      <Activity className="w-4 h-4 animate-spin" />
                      Connecting...
                    </>
                  ) : "Connect AWS"}
                </button>
                <button 
                  onClick={() => setSelectedProvider(null)}
                  className="px-6 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {!selectedProvider && (
          <div className="text-center">
            <p className="text-xs text-slate-500">Select a provider to continue setup</p>
          </div>
        )}
      </motion.div>
    </div>
  );
}

function KpiCard({ title, value, icon, trend, trendColor, status, isCritical }: { 
  title: string, value: string, icon: React.ReactNode, trend: string, trendColor?: string, status: string, isCritical?: boolean 
}) {
  return (
    <div className={cn(
      "bg-slate-900 border border-slate-800 rounded-xl p-6 transition-all duration-300 shadow-xl relative overflow-hidden group",
      isCritical && "border-red-500/20"
    )}>
      <div className="absolute top-4 right-4">
        <div className={cn(
          "text-[10px] font-bold px-2 py-0.5 rounded-full border",
          isCritical 
            ? "bg-red-950/50 text-red-400 border-red-500/30" 
            : "bg-slate-800/50 text-slate-400 border-slate-700/50"
        )}>
          {status}
        </div>
      </div>

      <div className="w-10 h-10 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
        {icon}
      </div>
      
      <div>
        <p className="text-xs font-medium text-slate-500 uppercase tracking-widest mb-1">{title}</p>
        <h3 className="text-3xl font-bold text-white tracking-tight">{value}</h3>
      </div>
      
      <div className="mt-4 flex items-center gap-1.5">
        <p className={cn("text-[11px] font-medium", trendColor || "text-slate-500")}>
          {trend}
        </p>
      </div>
    </div>
  );
}
