import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Square, History, Settings as SettingsIcon, TrendingUp, 
  MapPin, Timer, Volume2, VolumeX, ChevronLeft, 
  Calendar, Trash2, Zap, BarChart3, Activity
} from 'lucide-react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, 
  ResponsiveContainer, BarChart, Bar 
} from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  format, startOfWeek, endOfWeek, eachDayOfInterval, isSameDay, 
  subDays, startOfMonth, endOfMonth, startOfYear, endOfYear, parseISO 
} from 'date-fns';

// --- [Utility] 스타일 및 클래스 결합 ---
function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(' ');
}

// --- Types ---
interface Run {
  id: number;
  distance: number; 
  duration: number; 
  timestamp: string;
}

interface Stats {
  daily: { name: string; distance: number }[];
  weekly: { name: string; distance: number }[];
  monthly: { name: string; distance: number }[];
  yearly: { name: string; distance: number }[];
}

type View = 'dashboard' | 'active-run' | 'history' | 'stats' | 'settings';

const TIME_ALERTS = [
  { label: '5분', value: 300 },
  { label: '10분', value: 600 },
  { label: '15분', value: 900 },
  { label: '20분', value: 1200 },
  { label: '25분', value: 1500 },
  { label: '30분', value: 1800 },
  { label: '60분', value: 3600 },
];

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [isTracking, setIsTracking] = useState(false);
  const [distance, setDistance] = useState(0); 
  const [duration, setDuration] = useState(0); 
  const [lastAlertBucket, setLastAlertBucket] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [stats, setStats] = useState<Stats>({ daily: [], weekly: [], monthly: [], yearly: [] });
  const [gpsStatus, setGpsStatus] = useState<'searching' | 'active' | 'error'>('searching');
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [alertInterval, setAlertInterval] = useState(300); 

  const watchId = useRef<number | null>(null);
  const lastPosition = useRef<GeolocationCoordinates | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wakeLockRef = useRef<any>(null);

  // --- [Data Engine] 통계 및 데이터 관리 ---

  const calculateStatsLocally = (allRuns: Run[]) => {
    const now = new Date();
    
    const daily = Array.from({ length: 7 }).map((_, i) => {
      const d = subDays(now, 6 - i);
      const dayRuns = allRuns.filter(r => isSameDay(new Date(r.timestamp), d));
      return {
        name: format(d, 'MM/dd'),
        distance: Number((dayRuns.reduce((sum, r) => sum + r.distance, 0) / 1000).toFixed(2))
      };
    });

    const weekly = Array.from({ length: 4 }).map((_, i) => {
      const d = subDays(now, (3 - i) * 7);
      const s = startOfWeek(d);
      const weekRuns = allRuns.filter(r => new Date(r.timestamp) >= s && new Date(r.timestamp) <= endOfWeek(s));
      return {
        name: `${format(s, 'MM/dd')}`,
        distance: Number((weekRuns.reduce((sum, r) => sum + r.distance, 0) / 1000).toFixed(2))
      };
    });

    const monthly = Array.from({ length: 6 }).map((_, i) => {
      const d = startOfMonth(subDays(now, (5 - i) * 30));
      const mRuns = allRuns.filter(r => new Date(r.timestamp) >= d && new Date(r.timestamp) <= endOfMonth(d));
      return {
        name: format(d, 'MMM'),
        distance: Number((mRuns.reduce((sum, r) => sum + r.distance, 0) / 1000).toFixed(2))
      };
    });

    const yearly = Array.from({ length: 3 }).map((_, i) => {
      const d = startOfYear(subDays(now, (2 - i) * 365));
      const yRuns = allRuns.filter(r => new Date(r.timestamp) >= d && new Date(r.timestamp) <= endOfYear(d));
      return {
        name: format(d, 'yyyy'),
        distance: Number((yRuns.reduce((sum, r) => sum + r.distance, 0) / 1000).toFixed(2))
      };
    });

    setStats({ daily, weekly, monthly, yearly });
  };

  const loadData = () => {
    try {
      const saved = localStorage.getItem('stride_v7_final_runs');
      const allRuns = saved ? JSON.parse(saved) : [];
      setRuns(allRuns);
      calculateStatsLocally(allRuns);
    } catch (e) {
      setRuns([]);
    }
  };

  const deleteRun = (id: number) => {
    if (!confirm("기록을 삭제하시겠습니까?")) return;
    const updated = runs.filter(r => r.id !== id);
    setRuns(updated);
    localStorage.setItem('stride_v7_final_runs', JSON.stringify(updated));
    calculateStatsLocally(updated);
  };

  const saveRun = () => {
    const newRun: Run = {
      id: Date.now(),
      distance,
      duration,
      timestamp: new Date().toISOString(),
    };
    const updatedRuns = [newRun, ...runs];
    setRuns(updatedRuns);
    localStorage.setItem('stride_v7_final_runs', JSON.stringify(updatedRuns));
    calculateStatsLocally(updatedRuns);
  };

  // --- [Core Tracking Logic] GPS 및 배경 실행 보강 ---

  useEffect(() => {
    loadData();
    // 서비스 워커 업데이트 강제
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.update()));
    }
  }, []);

  // 화면 꺼짐 방지 API (WakeLock) 시도
  const requestWakeLock = async () => {
    if ('wakeLock' in navigator) {
      try {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
      } catch (err) { console.warn("WakeLock failed"); }
    }
  };

  const startSilentAudio = () => {
    if (!audioRef.current) {
      const silentSrc = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
      audioRef.current = new Audio(silentSrc);
      audioRef.current.loop = true;
    }
    audioRef.current.play().catch(() => {});
  };

  const stopSilentAudio = () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; }
  };

  const startTracking = () => {
    startSilentAudio();
    requestWakeLock();
    setDistance(0); setDuration(0); setLastAlertBucket(0);
    setGpsStatus('searching');
    lastPosition.current = null;
    startTimeRef.current = Date.now();

    // 1. 고정밀 타이머 (시스템 시각 동기화)
    timerRef.current = setInterval(() => {
      if (startTimeRef.current) {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 500);

    // 2. 최적화된 GPS 수신 로직
    if ("geolocation" in navigator) {
      watchId.current = navigator.geolocation.watchPosition(
        (pos) => {
          setGpsStatus('active');
          setGpsAccuracy(pos.coords.accuracy);
          
          if (lastPosition.current) {
            const d = calculateDistance(
              lastPosition.current.latitude, lastPosition.current.longitude,
              pos.coords.latitude, pos.coords.longitude
            );
            
            // 필터 완화: 0.5m 이상 이동 및 정확도 60m 이내 데이터 수용
            // 화면이 켜져 있을 때도 실시간으로 숫자가 올라가도록 조정
            if (d > 0.5 && pos.coords.accuracy < 60) {
              setDistance(prev => prev + d);
            }
          }
          lastPosition.current = pos.coords;
        },
        () => setGpsStatus('error'),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 25000 }
      );
    }
  };

  const stopTracking = () => {
    stopSilentAudio();
    if (wakeLockRef.current) wakeLockRef.current.release();
    if (watchId.current) navigator.geolocation.clearWatch(watchId.current);
    if (timerRef.current) clearInterval(timerRef.current);
    watchId.current = null; timerRef.current = null; startTimeRef.current = null;
  };

  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371e3;
    const p1 = lat1 * Math.PI / 180; const p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180; const dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  };

  const calculatePaceFormatted = (distM: number, timeS: number) => {
    if (distM < 5) return "0.00분/1km";
    const paceDecimal = (timeS / 60) / (distM / 1000);
    const mins = Math.floor(paceDecimal);
    const secs = Math.round((paceDecimal - mins) * 60);
    return `${mins}.${secs.toString().padStart(2, '0')}분/1km`;
  };

  const formatDuration = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // --- [Audio Fix] 화면 꺼짐 시 음성 출력 강제 활성화 ---
  useEffect(() => {
    if (isTracking && audioEnabled && duration > 0) {
      const currentBucket = Math.floor(duration / alertInterval);
      if (currentBucket > lastAlertBucket) {
        const mins = currentBucket * (alertInterval / 60);
        const distText = (distance / 1000).toFixed(2);
        
        // 트릭: 음성 출력 전에 무음 오디오를 한 번 더 터치하여 시스템 깨움
        if (audioRef.current) {
          audioRef.current.play().then(() => {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(`${mins}분 경과. 현재 거리는 ${distText} 킬로미터입니다.`);
            window.speechSynthesis.speak(utterance);
          });
        }
        
        setLastAlertBucket(currentBucket);
      }
    }
  }, [duration, isTracking, audioEnabled, alertInterval, lastAlertBucket, distance]);

  // --- [UI Render] ---

  const renderDashboard = () => {
    const todayDist = stats.daily[6]?.distance ?? 0;
    const lastPace = runs.length > 0 ? calculatePaceFormatted(runs[0].distance, runs[0].duration).split('분')[0] : "0.00";

    return (
      <div className="p-6 space-y-8 pb-24 h-full overflow-y-auto">
        <div className="flex justify-between items-center">
          <div><h1 className="text-4xl font-black text-slate-900 tracking-tight">StrideTrack</h1><p className="text-slate-500 font-medium">WebView Pro Mode</p></div>
          <button onClick={() => setView('settings')} className="p-3 rounded-full bg-slate-100 text-slate-600 shadow-sm"><SettingsIcon size={24} /></button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-emerald-500 p-5 rounded-3xl text-white shadow-lg flex flex-col justify-between h-32">
            <TrendingUp size={18} className="opacity-80" />
            <p className="text-3xl font-black">{todayDist.toFixed(2)} <span className="text-sm font-medium">km</span></p>
          </div>
          <div className="bg-white p-5 rounded-3xl border border-slate-100 shadow-sm flex flex-col justify-between h-32">
            <Zap size={18} className="text-emerald-500" />
            <p className="text-2xl font-black text-slate-900">{lastPace}<span className="text-xs font-normal text-slate-400 ml-1">분/km</span></p>
          </div>
        </div>

        <div className="flex flex-col items-center justify-center py-10">
          <motion.button 
            whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} 
            onClick={() => { setIsTracking(true); setView('active-run'); startTracking(); }} 
            className="w-44 h-44 rounded-full bg-emerald-500 shadow-2xl flex flex-col items-center justify-center text-white border-8 border-emerald-50"
          >
            <Play size={54} fill="currentColor" />
            <span className="font-black text-xl tracking-tighter">START</span>
          </motion.button>
        </div>

        <div className="space-y-4">
          <div className="flex justify-between items-end"><h2 className="text-xl font-black text-slate-900">Recent Runs</h2><button onClick={() => setView('history')} className="text-sm font-bold text-emerald-600">View All</button></div>
          <div className="space-y-3">
            {runs.slice(0, 3).map(run => (
              <div key={run.id} className="bg-white p-4 rounded-2xl border border-slate-50 flex justify-between items-center shadow-sm">
                <div><p className="font-black text-slate-900">{(run.distance / 1000).toFixed(2)} km</p><p className="text-xs font-medium text-slate-400">{format(new Date(run.timestamp), 'MMM d, HH:mm')}</p></div>
                <div className="text-right">
                  <p className="text-sm font-bold text-emerald-600">{calculatePaceFormatted(run.distance, run.duration)}</p>
                  <p className="text-xs font-medium text-slate-400">{formatDuration(run.duration)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderActiveRun = () => (
    <div className="h-full flex flex-col bg-slate-900 text-white p-8">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-2 px-3 py-1 bg-white/10 rounded-full">
          <div className={cn("w-2 h-2 rounded-full animate-pulse", gpsStatus === 'active' ? "bg-emerald-500" : "bg-amber-500")} />
          <span className="text-[10px] font-black uppercase tracking-widest">{gpsStatus === 'active' ? `GPS ON (${gpsAccuracy?.toFixed(0)}m)` : 'Searching GPS...'}</span>
        </div>
        <button onClick={() => setAudioEnabled(!audioEnabled)}>{audioEnabled ? <Volume2 size={24} className="text-emerald-400" /> : <VolumeX size={24} className="text-slate-500" />}</button>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center space-y-16">
        <div className="text-center">
          <p className="text-slate-500 font-bold uppercase tracking-[0.3em] text-sm">Distance</p>
          <h2 className="text-[9.5rem] font-black tracking-tighter leading-none">{(distance / 1000).toFixed(2)}</h2>
          <p className="text-3xl font-black text-emerald-400">KILOMETERS</p>
        </div>
        <div className="grid grid-cols-2 w-full gap-12 text-center">
          <div><p className="text-slate-500 text-xs font-bold uppercase mb-2">Time</p><p className="text-4xl font-black">{formatDuration(duration)}</p></div>
          <div><p className="text-slate-500 text-xs font-bold uppercase mb-2">Avg Pace</p><p className="text-4xl font-black text-emerald-400">{calculatePaceFormatted(distance, duration).split('분')[0]}</p></div>
        </div>
      </div>
      <div className="pb-10"><button onClick={() => { saveRun(); stopTracking(); setIsTracking(false); setView('dashboard'); }} className="w-full bg-rose-500 text-white font-black py-5 rounded-3xl text-xl shadow-2xl active:scale-95 transition-transform">FINISH RUN</button></div>
    </div>
  );

  const renderHistory = () => (
    <div className="p-6 space-y-6 pb-24 h-full overflow-y-auto">
      <div className="flex items-center gap-4"><button onClick={() => setView('dashboard')} className="p-2 rounded-xl bg-slate-100 text-slate-600 shadow-sm"><ChevronLeft size={24} /></button><h1 className="text-3xl font-black text-slate-900 tracking-tight">Run History</h1></div>
      <div className="space-y-4">
        {runs.map(run => (
          <div key={run.id} className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm space-y-4">
            <div className="flex justify-between items-start">
              <div><p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">{format(new Date(run.timestamp), 'EEEE, MMMM d')}</p><h3 className="text-3xl font-black text-slate-900">{(run.distance / 1000).toFixed(2)} km</h3></div>
              <button onClick={() => deleteRun(run.id)} className="p-2 text-slate-300 hover:text-rose-500 transition-colors"><Trash2 size={22} /></button>
            </div>
            <div className="grid grid-cols-2 gap-4 border-t border-slate-50 pt-4 text-center">
              <div><p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Time</p><p className="font-black text-slate-700 text-sm">{formatDuration(run.duration)}</p></div>
              <div><p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Pace</p><p className="font-black text-emerald-600 text-sm">{calculatePaceFormatted(run.distance, run.duration)}</p></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderStats = () => {
    const [statTab, setStatTab] = useState<'day' | 'week' | 'month' | 'year'>('day');
    const chartData = statTab === 'day' ? stats.daily : statTab === 'week' ? stats.weekly : statTab === 'month' ? stats.monthly : stats.yearly;
    return (
      <div className="p-6 space-y-6 pb-24 h-full overflow-y-auto">
        <div className="flex items-center gap-4"><button onClick={() => setView('dashboard')} className="p-2 rounded-xl bg-slate-100 text-slate-600 shadow-sm"><ChevronLeft size={24} /></button><h1 className="text-3xl font-black text-slate-900 tracking-tight">Analytics</h1></div>
        <div className="flex p-1.5 bg-slate-100 rounded-2xl">
          {['day', 'week', 'month', 'year'].map(tab => (<button key={tab} onClick={() => setStatTab(tab as any)} className={cn("flex-1 py-2.5 text-xs font-black rounded-xl capitalize transition-all", statTab === tab ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500")}>{tab}</button>))}
        </div>
        <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm">
          <h3 className="text-sm font-black text-slate-900 flex items-center gap-2 mb-6"><TrendingUp size={18} className="text-emerald-500" /> Distance (km)</h3>
          <div className="h-64 w-full"><ResponsiveContainer><BarChart data={chartData}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" /><XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fontSize: 10, fontWeight: 700, fill: '#94a3b8'}} /><Tooltip cursor={{fill: '#f8fafc'}} contentStyle={{borderRadius: '20px', border: 'none', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1)'}} /><Bar dataKey="distance" fill="#10b981" radius={[8, 8, 0, 0]} barSize={24} /></BarChart></ResponsiveContainer></div>
        </div>
      </div>
    );
  };

  const renderSettings = () => (
    <div className="p-6 space-y-8 h-full overflow-y-auto">
      <div className="flex items-center gap-4"><button onClick={() => setView('dashboard')} className="p-2 rounded-xl bg-slate-100 text-slate-600 shadow-sm"><ChevronLeft size={24} /></button><h1 className="text-3xl font-black text-slate-900 tracking-tight">Settings</h1></div>
      <div className="space-y-6">
        <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm space-y-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4"><div className={cn("p-3 rounded-2xl", audioEnabled ? "bg-emerald-50 text-emerald-600" : "bg-slate-50 text-slate-400")}><Volume2 size={24} /></div><div><p className="font-black text-slate-900">Voice Alerts</p><p className="text-xs font-medium text-slate-500">Audio feedback by time</p></div></div>
            <button onClick={() => setAudioEnabled(!audioEnabled)} className={cn("w-14 h-8 rounded-full transition-all relative shadow-inner", audioEnabled ? "bg-emerald-500" : "bg-slate-200")}><div className={cn("absolute top-1 w-6 h-6 bg-white rounded-full transition-all shadow-sm", audioEnabled ? "left-7" : "left-1")} /></button>
          </div>
          <div className="space-y-4">
            <p className="text-sm font-black text-slate-900 tracking-tight">Time Interval (Minutes)</p>
            <div className="grid grid-cols-3 gap-2">
              {TIME_ALERTS.map(item => (<button key={item.value} onClick={() => setAlertInterval(item.value)} className={cn("py-3 rounded-2xl text-xs font-black transition-all border-2", alertInterval === item.value ? "bg-emerald-50 border-emerald-500 text-emerald-600 scale-[1.05]" : "bg-white border-slate-50 text-slate-400")}>{item.label}</button>))}
            </div>
          </div>
        </div>
        <div className="bg-slate-900 p-8 rounded-[2.5rem] text-white shadow-xl"><h3 className="text-lg font-black mb-2">StrideTrack Pro</h3><p className="text-xs text-slate-400 font-medium leading-relaxed">Background GPS & Audio Sync is active. For best results, keep the app excluded from battery optimization.</p></div>
      </div>
    </div>
  );

  return (
    <div className="max-w-md mx-auto h-screen bg-slate-50 overflow-hidden font-sans relative">
      <AnimatePresence mode="wait">
        <motion.div key={view} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.25 }} className="h-full">
          {view === 'dashboard' && renderDashboard()}
          {view === 'active-run' && renderActiveRun()}
          {view === 'history' && renderHistory()}
          {view === 'stats' && renderStats()}
          {view === 'settings' && renderSettings()}
        </motion.div>
      </AnimatePresence>
      {view !== 'active-run' && (
        <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white/90 backdrop-blur-xl border-t border-slate-100 px-8 py-4 flex justify-between items-center z-50">
          <button onClick={() => setView('dashboard')} className={cn("p-2 flex flex-col items-center gap-1", view === 'dashboard' ? "text-emerald-600 scale-110" : "text-slate-300")}><Play size={20} fill={view === 'dashboard' ? "currentColor" : "none"} /><span className="text-[10px] font-bold">Run</span></button>
          <button onClick={() => setView('stats')} className={cn("p-2 flex flex-col items-center gap-1", view === 'stats' ? "text-emerald-600 scale-110" : "text-slate-300")}><TrendingUp size={20} /><span className="text-[10px] font-bold">Stats</span></button>
          <button onClick={() => setView('history')} className={cn("p-2 flex flex-col items-center gap-1", view === 'history' ? "text-emerald-600 scale-110" : "text-slate-300")}><History size={20} /><span className="text-[10px] font-bold">History</span></button>
          <button onClick={() => setView('settings')} className={cn("p-2 flex flex-col items-center gap-1", view === 'settings' ? "text-emerald-600 scale-110" : "text-slate-300")}><SettingsIcon size={20} /><span className="text-[10px] font-bold">Settings</span></button>
        </div>
      )}
    </div>
  );
}