import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Square, History, Settings as SettingsIcon, TrendingUp, 
  MapPin, Timer, Volume2, VolumeX, ChevronLeft, Calendar, Trash2, Zap
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

// --- [Utility] 외부 파일 의존성 해결용 ---
function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(' ');
}

// --- Types (Steps 완전 제거됨) ---
interface Run {
  id: number;
  distance: number; // meters
  duration: number; // seconds
  timestamp: string;
}

interface Stats {
  daily: { date: string; distance: number }[];
  weekly: { week: string; distance: number }[];
  monthly: { month: string; distance: number }[];
}

type View = 'dashboard' | 'active-run' | 'history' | 'stats' | 'settings';

// [수정] 시간 단위 알림 설정값 (초 단위: 5분=300초, 10분=600초 등)
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
  const [lastAlertBucket, setLastAlertBucket] = useState(0); // 시간 알림 구간 체크용
  const [runs, setRuns] = useState<Run[]>([]);
  const [stats, setStats] = useState<Stats>({ daily: [], weekly: [], monthly: [] });
  const [gpsStatus, setGpsStatus] = useState<'searching' | 'active' | 'error'>('searching');
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  
  // Settings
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [alertInterval, setAlertInterval] = useState(300); // 기본 5분
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const watchId = useRef<number | null>(null);
  const lastPosition = useRef<GeolocationCoordinates | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // --- [Data Logic] 로컬 데이터 처리 (Steps 제거 버전) ---

  const calculateStatsLocally = (allRuns: Run[]) => {
    const now = new Date();
    
    const daily = Array.from({ length: 7 }).map((_, i) => {
      const d = subDays(now, i);
      const dayRuns = allRuns.filter(r => isSameDay(new Date(r.timestamp), d));
      return {
        date: format(d, 'yyyy-MM-dd'),
        distance: dayRuns.reduce((sum, r) => sum + r.distance, 0)
      };
    });

    const weekly = Array.from({ length: 4 }).map((_, i) => {
      const d = subDays(now, i * 7);
      const s = startOfWeek(d);
      const weekRuns = allRuns.filter(r => {
        const rDate = new Date(r.timestamp);
        return rDate >= s && rDate <= endOfWeek(s);
      });
      return {
        week: `${format(s, 'MM/dd')}`,
        distance: weekRuns.reduce((sum, r) => sum + r.distance, 0)
      };
    });

    const monthly = Array.from({ length: 6 }).map((_, i) => {
      const d = startOfMonth(subDays(now, i * 30));
      const monthRuns = allRuns.filter(r => {
        const rDate = new Date(r.timestamp);
        return rDate >= d && rDate <= endOfMonth(d);
      });
      return {
        month: format(d, 'MMM'),
        distance: monthRuns.reduce((sum, r) => sum + r.distance, 0)
      };
    });

    setStats({ daily, weekly, monthly });
  };

  const fetchRuns = async () => {
    const saved = localStorage.getItem('stridetrack_final_runs');
    const allRuns = saved ? JSON.parse(saved) : [];
    setRuns(allRuns);
    calculateStatsLocally(allRuns);
  };

  const saveRun = async () => {
    const newRun: Run = {
      id: Date.now(),
      distance,
      duration,
      timestamp: new Date().toISOString(),
    };
    const updatedRuns = [newRun, ...runs];
    setRuns(updatedRuns);
    localStorage.setItem('stridetrack_final_runs', JSON.stringify(updatedRuns));
    calculateStatsLocally(updatedRuns);
  };

  const deleteRun = (id: number) => {
    if (!confirm("이 기록을 삭제하시겠습니까?")) return;
    const updated = runs.filter(r => r.id !== id);
    setRuns(updated);
    localStorage.setItem('stridetrack_final_runs', JSON.stringify(updated));
    calculateStatsLocally(updated);
  };

  // --- [Logic] GPS, 오디오 트래킹 엔진 ---

  useEffect(() => {
    fetchRuns();
  }, []);

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
    setDistance(0); setDuration(0); setLastAlertBucket(0);
    setGpsStatus('searching');
    lastPosition.current = null;
    startTimeRef.current = Date.now();

    // [복원] 업로드 코드와 동일한 타이머 & 시스템 시각 동기화
    timerRef.current = setInterval(() => {
      if (startTimeRef.current) {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setDuration(elapsed);
      }
    }, 500);

    // [복원] 업로드 코드의 GPS 방식 (실내/약한 신호에서도 측정 가능)
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
            // 업로드 코드 방식: 1m 이상 이동 시 합산 (오차 필터링 최소화)
            if (d > 1 && pos.coords.accuracy < 50) {
              setDistance(prev => prev + d);
            }
          }
          lastPosition.current = pos.coords;
        },
        () => setGpsStatus('error'),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
      );
    }
  };

  const stopTracking = () => {
    stopSilentAudio();
    if (watchId.current) navigator.geolocation.clearWatch(watchId.current);
    if (timerRef.current) clearInterval(timerRef.current);
    watchId.current = null; timerRef.current = null;
    startTimeRef.current = null;
  };

  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180; const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180; const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  };

  // [추가] 킬로미터당 페이스 (4.27분/km 형식)
  const calculatePaceFormatted = (distM: number, timeS: number) => {
    if (distM < 10) return "0.00분/1km";
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

  // [수정] 정확한 시간 기반 음성 알림 (화면 꺼짐 대응 로직 강화)
  useEffect(() => {
    if (isTracking && audioEnabled && duration > 0) {
      const currentBucket = Math.floor(duration / alertInterval);
      if (currentBucket > lastAlertBucket) {
        const mins = currentBucket * (alertInterval / 60);
        const distText = (distance / 1000).toFixed(2);
        
        // 화면이 꺼져 있을 때 음성 엔진을 강제로 깨우는 시도
        const utterance = new SpeechSynthesisUtterance(`${mins}분 경과. 현재 거리는 ${distText} 킬로미터입니다.`);
        window.speechSynthesis.cancel(); // 이전 음성 취소 후 즉시 실행
        window.speechSynthesis.speak(utterance);
        
        setLastAlertBucket(currentBucket);
      }
    }
  }, [duration, isTracking, audioEnabled, alertInterval, lastAlertBucket, distance]);

  // --- [UI Render] ---

  const renderDashboard = () => (
    <div className="p-6 space-y-8 pb-24 h-full overflow-y-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-black text-slate-900 tracking-tight">StrideTrack</h1>
          <p className="text-slate-500 font-medium">Ready for a better run?</p>
        </div>
        <button onClick={() => setView('settings')} className="p-3 rounded-full bg-slate-100 text-slate-600 shadow-sm"><SettingsIcon size={24} /></button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-emerald-500 p-5 rounded-3xl text-white shadow-lg shadow-emerald-100 flex flex-col justify-between h-32">
          <div className="flex items-center gap-2 mb-2 opacity-90"><TrendingUp size={16} /><span className="text-xs font-bold uppercase tracking-widest">Today</span></div>
          <p className="text-3xl font-black">{(stats.daily[0]?.distance / 1000 || 0).toFixed(2)} <span className="text-sm font-medium">km</span></p>
        </div>
        <div className="bg-white p-5 rounded-3xl border border-slate-100 shadow-sm flex flex-col justify-between h-32">
          <div className="flex items-center gap-2 mb-2 text-emerald-500"><Zap size={16} /><span className="text-xs font-bold uppercase tracking-widest">Avg Pace</span></div>
          <p className="text-2xl font-black text-slate-900">
            {runs.length > 0 ? calculatePaceFormatted(runs[0].distance, runs[0].duration).split('분')[0] : "0.00"}
            <span className="text-xs font-normal text-slate-400 ml-1">분/km</span>
          </p>
        </div>
      </div>

      <div className="flex flex-col items-center justify-center py-10">
        <motion.button 
          whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} 
          onClick={() => { setIsTracking(true); setView('active-run'); startTracking(); }} 
          className="w-44 h-44 rounded-full bg-emerald-500 shadow-2xl flex flex-col items-center justify-center text-white gap-2 border-8 border-emerald-50"
        >
          <Play size={54} fill="currentColor" />
          <span className="font-black text-xl tracking-tighter">START</span>
        </motion.button>
      </div>

      <div className="space-y-4">
        <div className="flex justify-between items-end"><h2 className="text-xl font-black text-slate-900">Recent History</h2><button onClick={() => setView('history')} className="text-sm font-bold text-emerald-600">View All</button></div>
        <div className="space-y-3">
          {runs.slice(0, 3).map(run => (
            <div key={run.id} className="bg-white p-4 rounded-2xl border border-slate-50 flex justify-between items-center shadow-sm">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-400"><MapPin size={24} /></div>
                <div><p className="font-black text-slate-900">{(run.distance / 1000).toFixed(2)} km</p><p className="text-xs font-medium text-slate-400">{format(new Date(run.timestamp), 'MMM d, HH:mm')}</p></div>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-emerald-600">{calculatePaceFormatted(run.distance, run.duration)}</p>
                <p className="text-xs font-medium text-slate-400">{formatDuration(run.duration)}</p>
              </div>
            </div>
          ))}
          {runs.length === 0 && <p className="text-center text-slate-400 py-10 bg-slate-50 rounded-3xl border-2 border-dashed">No runs yet. Start your first one!</p>}
        </div>
      </div>
    </div>
  );

  const renderActiveRun = () => (
    <div className="h-full flex flex-col bg-slate-900 text-white p-8">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-2 px-3 py-1 bg-white/10 rounded-full">
          <div className={cn("w-2 h-2 rounded-full animate-pulse", gpsStatus === 'active' ? "bg-emerald-500" : "bg-amber-500")} />
          <span className="text-[10px] font-black uppercase tracking-widest">{gpsStatus === 'active' ? `GPS ACTIVE (${gpsAccuracy?.toFixed(0)}m)` : 'Searching GPS...'}</span>
        </div>
        <button onClick={() => setAudioEnabled(!audioEnabled)}>{audioEnabled ? <Volume2 size={24} className="text-emerald-400" /> : <VolumeX size={24} className="text-slate-500" />}</button>
      </div>
      
      <div className="flex-1 flex flex-col items-center justify-center space-y-16">
        <div className="text-center">
          <p className="text-slate-500 font-bold uppercase tracking-[0.3em] text-sm mb-4">Distance</p>
          <h2 className="text-[9rem] font-black tracking-tighter leading-none">{(distance / 1000).toFixed(2)}</h2>
          <p className="text-3xl font-black text-emerald-400 mt-4">KILOMETERS</p>
        </div>

        <div className="grid grid-cols-2 w-full gap-12 text-center">
          <div className="border-r border-white/10">
            <div className="flex items-center justify-center gap-2 text-slate-500 mb-2"><Timer size={18} /><span className="text-xs font-bold uppercase tracking-widest">Time</span></div>
            <p className="text-4xl font-black">{formatDuration(duration)}</p>
          </div>
          <div>
            <div className="flex items-center justify-center gap-2 text-slate-500 mb-2"><Zap size={18} /><span className="text-xs font-bold uppercase tracking-widest">Avg Pace</span></div>
            <p className="text-4xl font-black text-emerald-400">{calculatePaceFormatted(distance, duration).split('분')[0]}</p>
          </div>
        </div>
      </div>

      <div className="pb-10">
        <button onClick={() => { saveRun(); stopTracking(); setIsTracking(false); setView('dashboard'); }} className="w-full bg-rose-500 hover:bg-rose-600 text-white font-black py-5 rounded-3xl text-xl shadow-2xl active:scale-95 transition-transform">FINISH RUN</button>
      </div>
    </div>
  );

  const renderHistory = () => (
    <div className="p-6 space-y-6 pb-24 h-full overflow-y-auto">
      <div className="flex items-center gap-4">
        <button onClick={() => setView('dashboard')} className="p-2 rounded-xl bg-slate-100 text-slate-600"><ChevronLeft size={24} /></button>
        <h1 className="text-3xl font-black text-slate-900 tracking-tight">Run History</h1>
      </div>
      <div className="space-y-4">
        {runs.map(run => (
          <div key={run.id} className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">{format(new Date(run.timestamp), 'EEEE, MMMM d')}</p>
                <h3 className="text-3xl font-black text-slate-900">{(run.distance / 1000).toFixed(2)} km</h3>
              </div>
              <button onClick={() => deleteRun(run.id)} className="p-2 text-slate-300 hover:text-rose-500 transition-colors"><Trash2 size={22} /></button>
            </div>
            <div className="grid grid-cols-2 gap-4 border-t border-slate-50 pt-4 text-center">
              <div><p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Duration</p><p className="font-black text-slate-700 text-sm">{formatDuration(run.duration)}</p></div>
              <div><p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Avg Pace</p><p className="font-black text-emerald-600 text-sm">{calculatePaceFormatted(run.distance, run.duration)}</p></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderStats = () => {
    const [statTab, setStatTab] = useState<'day' | 'week' | 'month'>('day');
    const chartData = statTab === 'day' ? stats.daily : statTab === 'week' ? stats.weekly : stats.monthly;
    const formattedData = chartData.map(d => ({
      name: (d as any).date ? format(new Date((d as any).date), 'dd') : (d as any).week || (d as any).month,
      distance: Number(((d.distance || 0) / 1000).toFixed(2))
    })).reverse();

    return (
      <div className="p-6 space-y-6 pb-24 h-full overflow-y-auto">
        <div className="flex items-center gap-4"><button onClick={() => setView('dashboard')} className="p-2 rounded-xl bg-slate-100 text-slate-600"><ChevronLeft size={24} /></button><h1 className="text-3xl font-black text-slate-900 tracking-tight">Stats</h1></div>
        <div className="flex p-1.5 bg-slate-100 rounded-2xl">
          {['day', 'week', 'month'].map(tab => (
            <button key={tab} onClick={() => setStatTab(tab as any)} className={cn("flex-1 py-2.5 text-xs font-black rounded-xl capitalize transition-all", statTab === tab ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500")}>{tab}</button>
          ))}
        </div>
        <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm">
          <h3 className="text-sm font-black text-slate-900 flex items-center gap-2 mb-6"><TrendingUp size={18} className="text-emerald-500" /> Distance (km)</h3>
          <div className="h-64 w-full">
            <ResponsiveContainer>
              <BarChart data={formattedData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fontSize: 10, fontWeight: 700, fill: '#94a3b8'}} />
                <Tooltip cursor={{fill: '#f8fafc'}} contentStyle={{borderRadius: '20px', border: 'none'}} />
                <Bar dataKey="distance" fill="#10b981" radius={[8, 8, 0, 0]} barSize={24} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    );
  };

  const renderSettings = () => (
    <div className="p-6 space-y-8 h-full overflow-y-auto">
      <div className="flex items-center gap-4"><button onClick={() => setView('dashboard')} className="p-2 rounded-xl bg-slate-100 text-slate-600"><ChevronLeft size={24} /></button><h1 className="text-3xl font-black text-slate-900 tracking-tight">Settings</h1></div>
      <div className="space-y-6">
        <div className="bg-white p-6 rounded-[2.5rem] border border-slate-100 shadow-sm space-y-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className={cn("p-3 rounded-2xl", audioEnabled ? "bg-emerald-50 text-emerald-600" : "bg-slate-50 text-slate-400")}><Volume2 size={24} /></div>
              <div><p className="font-black text-slate-900">Voice Alerts</p><p className="text-xs font-medium text-slate-500">Audio feedback by time</p></div>
            </div>
            <button onClick={() => setAudioEnabled(!audioEnabled)} className={cn("w-14 h-8 rounded-full transition-all relative", audioEnabled ? "bg-emerald-500" : "bg-slate-200")}><div className={cn("absolute top-1 w-6 h-6 bg-white rounded-full transition-all shadow-sm", audioEnabled ? "left-7" : "left-1")} /></button>
          </div>
          <div className="space-y-4">
            <p className="text-sm font-black text-slate-900 tracking-tight">Voice Interval (Minutes)</p>
            <div className="grid grid-cols-3 gap-2">
              {TIME_ALERTS.map(item => (
                <button key={item.value} onClick={() => setAlertInterval(item.value)} className={cn("py-3 rounded-2xl text-xs font-black transition-all border-2", alertInterval === item.value ? "bg-emerald-50 border-emerald-500 text-emerald-600 scale-[1.05]" : "bg-white border-slate-50 text-slate-400")}>{item.label}</button>
              ))}
            </div>
          </div>
        </div>
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
          <button onClick={() => setView('dashboard')} className={cn("p-2 flex flex-col items-center gap-1 transition-all", view === 'dashboard' ? "text-emerald-600 scale-110" : "text-slate-300")}>
            <Play size={20} fill={view === 'dashboard' ? "currentColor" : "none"} />
            <span className="text-[10px] font-black uppercase tracking-widest">Run</span>
          </button>
          <button onClick={() => setView('stats')} className={cn("p-2 flex flex-col items-center gap-1 transition-all", view === 'stats' ? "text-emerald-600 scale-110" : "text-slate-300")}>
            <TrendingUp size={20} />
            <span className="text-[10px] font-black uppercase tracking-widest">Stats</span>
          </button>
          <button onClick={() => setView('history')} className={cn("p-2 flex flex-col items-center gap-1 transition-all", view === 'history' ? "text-emerald-600 scale-110" : "text-slate-300")}>
            <History size={20} />
            <span className="text-[10px] font-black uppercase tracking-widest">History</span>
          </button>
          <button onClick={() => setView('settings')} className={cn("p-2 flex flex-col items-center gap-1 transition-all", view === 'settings' ? "text-emerald-600 scale-110" : "text-slate-300")}>
            <SettingsIcon size={20} />
            <span className="text-[10px] font-black uppercase tracking-widest">Settings</span>
          </button>
        </div>
      )}
    </div>
  );
}