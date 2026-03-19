import React, { useState, useEffect, useMemo } from 'react';
import {
  signInAnonymously,
  onAuthStateChanged
} from 'firebase/auth';
import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp
} from 'firebase/firestore';
import { auth, db, APP_ID } from './services/firebase';
import {
  Calculator,
  Clock,
  MapPin,
  Users,
  Moon,
  AlertCircle,
  CheckCircle2,
  FileText,
  Car,
  History,
  Plus,
  Trash2,
  User,
  Map
} from 'lucide-react';

// Firebase is initialized via services/firebase.ts (uses VITE_ env vars)
const appId = APP_ID;

// --- Data: Predefined Locations ---
const PREDEFINED_LOCATIONS = [
  { region: "台北", name: "內湖區金湖路365號", hours: 2.5 },
  { region: "新北", name: "淡水區崁頂里", hours: 3.0 },
  { region: "新竹", name: "湖口542營區 (湖口北測中心)", hours: 1.5 },
  { region: "新竹", name: "新竹市北區東大路三段179巷", hours: 1.5 },
  { region: "新竹", name: "新竹關西新訓中心 (老庚寮22號)", hours: 2.0 },
  { region: "新竹", name: "新竹空軍基地", hours: 1.5 },
  { region: "新竹", name: "工研院", hours: 1.5 },
  { region: "桃園", name: "桃園市中壢區龍東路1號", hours: 2.0 },
  { region: "桃園", name: "銀河營區 (龜山區樹人路305巷296號)", hours: 2.0 },
  { region: "桃園", name: "高山頂營區 (雄獅部隊)", hours: 2.0 },
  { region: "桃園", name: "彗星營區", hours: 2.0 },
  { region: "桃園", name: "桃園高鐵站", hours: 2.0 },
  { region: "桃園", name: "桃科5號門", hours: 2.0 },
  { region: "桃園", name: "台灣大電力 (桃園觀音)", hours: 2.0 },
  { region: "桃園", name: "臺威 (桃園龜山)", hours: 2.0 },
  { region: "桃園", name: "桃園金龍營區", hours: 2.0 },
  { region: "桃園", name: "桃園市楊梅區楊湖路一段367巷", hours: 2.0 },
  { region: "宜蘭", name: "宜蘭紅柴林", hours: 3.5 },
  { region: "宜蘭", name: "宜蘭武荖坑", hours: 3.0 },
  { region: "宜蘭", name: "龍德造船廠第六廠", hours: 3.0 },
  { region: "宜蘭", name: "宜蘭蘇澳乾塢營區", hours: 3.0 },
  { region: "宜蘭", name: "宜蘭蘇澳港", hours: 3.0 },
  { region: "高雄", name: "海軍左營基地 (左營區介壽路10號)", hours: 2.0 },
  { region: "高雄", name: "左營中正哨", hours: 2.0 },
  { region: "高雄", name: "高雄陸戰隊隊史館", hours: 2.0 },
  { region: "高雄", name: "金湯營區 (高雄步校)", hours: 2.0 },
  { region: "高雄", name: "高雄天山營區", hours: 1.5 },
  { region: "高雄", name: "高雄市旗津區中洲二路462-6號 (精一)", hours: 2.0 },
  { region: "高雄", name: "嘉興營區", hours: 1.5 },
  { region: "屏東", name: "屏東空軍基地", hours: 2.0 },
  { region: "屏東", name: "加祿堂營區", hours: 2.5 },
  { region: "屏東", name: "恆春鎮東海路", hours: 3.5 },
  { region: "台南", name: "台南陸軍航空特戰指揮部", hours: 1.5 },
  { region: "台南", name: "台南空軍基地", hours: 1.5 },
  { region: "台南", name: "台南長安營區 (仁德智測站)", hours: 1.5 },
  { region: "台南", name: "台南市仁德區保仁路195號", hours: 1.5 },
  { region: "花蓮", name: "七星潭 (經台東大學)", hours: 7.5 },
  { region: "台東", name: "志航空軍基地 (台東市志航路三段)", hours: 4.5 },
];

const LOCATION_GROUPS = PREDEFINED_LOCATIONS.reduce((groups, loc) => {
  if (!groups[loc.region]) groups[loc.region] = [];
  groups[loc.region].push(loc);
  return groups;
}, {} as Record<string, typeof PREDEFINED_LOCATIONS>);

// --- Types ---
interface TravelRequest {
  id?: string;
  userId: string;
  applicants: string[];
  reason: string;
  destination: string;
  date: string;
  startTime: string;
  endTime: string;
  oneWayHours: number;
  passengers: number;
  nights: number;

  // Calculated Results
  fatigueAllowanceTotal: number;
  travelAllowanceTotal: number;
  overnightAllowanceTotal: number;
  grandTotal: number;

  perPersonTravel: number;
  perPersonFatigue: number;
  perPersonOvernight: number;

  eligibleForLateStart: boolean;
  allowedRestTime: number;

  timestamp?: any;
}

// --- Main Component ---
export default function App() {
  const [user, setUser] = useState<any>(null);
  const [history, setHistory] = useState<TravelRequest[]>([]);
  const [activeTab, setActiveTab] = useState<'form' | 'list'>('form');
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    const now = new Date();
    return `${now.getFullYear()} -${String(now.getMonth() + 1).padStart(2, '0')} `;
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form State
  const [formData, setFormData] = useState<{
    applicants: string[];
    reason: string;
    destination: string;
    date: string;
    startTime: string;
    endTime: string;
    oneWayHours: number;
    nights: number;
  }>({
    applicants: [''],
    reason: '',
    destination: '',
    date: new Date().toISOString().split('T')[0],
    startTime: '08:00',
    endTime: '17:00',
    oneWayHours: 0,
    nights: 0,
  });

  // --- Auth & Data Fetching ---
  useEffect(() => {
    const initAuth = async () => {
      await signInAnonymously(auth);
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'artifacts', appId, 'public', 'data', 'travel_allowances'),
      orderBy('timestamp', 'desc')
    );
    const unsubscribeSnapshot = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TravelRequest));
      setHistory(docs);
    });
    return () => unsubscribeSnapshot();
  }, [user]);

  // --- Business Logic Calculation ---
  const calculation = useMemo(() => {
    let singlePersonFatigue = 0;
    let carTotalAllowance = 0;
    let singlePersonOvernight = 0;

    let isLateStartEligible = false;
    let restTime = 0;

    const headcount = Math.max(1, formData.applicants.length);

    // 1. 高疲勞值計算 (修正 Bug: 05:00 應包含在內)
    const [startH, startM] = formData.startTime.split(':').map(Number);
    const [endH, endM] = formData.endTime.split(':').map(Number);

    // 轉為十進位小數
    const startDec = startH + startM / 60;
    const endDec = endH + endM / 60;

    // Rule A: Early Start (00:00 - 05:00)
    // 修正: 使用 <= 5，確保 05:00 整出發也符合資格
    if (startDec <= 5) {
      // 計算從出發時間到 08:00 的時數
      const duration = 8 - startDec; // e.g., 5:00 -> 3 hrs
      // 最小計算單位 0.5 小時
      // 使用 Math.floor(x * 2) / 2 來確保以 0.5 為單位向下取整 (保守計算)，或者依貴司習慣改為 round
      // 此處邏輯：5:00 出發 -> duration 3 -> 3.0
      // 4:55 出發 -> duration 3.08 -> 3.0
      const billableHours = Math.floor(duration * 2) / 2;
      singlePersonFatigue += billableHours * 200;
    }

    // Rule B: Late Arrival (> 21:00)
    if (endDec > 21) {
      isLateStartEligible = true;
      const rawHours = endDec - 21;
      const billableHours = Math.floor(rawHours * 2) / 2;
      singlePersonFatigue += billableHours * 200;
    }

    // 2. 車程加給
    const oneWayHours = formData.oneWayHours;
    const units = Math.floor(oneWayHours / 1.5);
    const singleTripAllowance = units * 30;
    carTotalAllowance = singleTripAllowance * 2;

    restTime = Math.floor(oneWayHours / 1.5) * 15;

    // 3. 跨日津貼
    singlePersonOvernight = formData.nights * 300;

    const fatigueTotal = singlePersonFatigue * headcount;
    const overnightTotal = singlePersonOvernight * headcount;

    return {
      fatigueTotal,
      travelTotal: carTotalAllowance,
      overnightTotal,
      grandTotal: fatigueTotal + carTotalAllowance + overnightTotal,

      perPersonFatigue: singlePersonFatigue,
      perPersonOvernight: singlePersonOvernight,
      perPersonTravel: carTotalAllowance / headcount,

      lateStart: isLateStartEligible,
      rest: restTime,
      headcount
    };

  }, [formData.startTime, formData.endTime, formData.oneWayHours, formData.applicants.length, formData.nights]);

  // --- Handlers ---
  const handleApplicantChange = (index: number, value: string) => {
    const newApplicants = [...formData.applicants];
    newApplicants[index] = value;
    setFormData(prev => ({ ...prev, applicants: newApplicants }));
  };

  const addApplicant = () => {
    setFormData(prev => ({ ...prev, applicants: [...prev.applicants, ''] }));
  };

  const removeApplicant = (index: number) => {
    if (formData.applicants.length <= 1) return;
    const newApplicants = formData.applicants.filter((_, i) => i !== index);
    setFormData(prev => ({ ...prev, applicants: newApplicants }));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'number' ? Number(value) : value
    }));
  };

  const handleLocationSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedName = e.target.value;
    if (!selectedName) return;

    const location = PREDEFINED_LOCATIONS.find(loc => loc.name === selectedName);
    if (location) {
      setFormData(prev => ({
        ...prev,
        destination: location.name,
        oneWayHours: location.hours
      }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    if (formData.applicants.some(name => !name.trim())) {
      alert("請填寫所有出差人員姓名");
      return;
    }

    setIsSubmitting(true);

    try {
      const payload: TravelRequest = {
        userId: user.uid,
        applicants: formData.applicants,
        passengers: calculation.headcount,
        reason: formData.reason,
        destination: formData.destination,
        date: formData.date,
        startTime: formData.startTime,
        endTime: formData.endTime,
        oneWayHours: formData.oneWayHours,
        nights: formData.nights,

        fatigueAllowanceTotal: calculation.fatigueTotal,
        travelAllowanceTotal: calculation.travelTotal,
        overnightAllowanceTotal: calculation.overnightTotal,
        grandTotal: calculation.grandTotal,

        perPersonTravel: calculation.perPersonTravel,
        perPersonFatigue: calculation.perPersonFatigue,
        perPersonOvernight: calculation.perPersonOvernight,

        eligibleForLateStart: calculation.lateStart,
        allowedRestTime: calculation.rest,
        timestamp: serverTimestamp()
      };

      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'travel_allowances'), payload);

      setFormData(prev => ({
        ...prev,
        applicants: [''],
        reason: '',
        destination: '',
        startTime: '08:00',
        endTime: '17:00',
        oneWayHours: 0,
        nights: 0
      }));

      setActiveTab('list');
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', minimumFractionDigits: 0 }).format(val);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans pb-10">

      {/* Header */}
      <header className="bg-blue-900 text-white shadow-lg sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="bg-white/10 p-2 rounded-lg">
              <Car className="w-6 h-6 text-yellow-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-wide">遠地出差津貼申請系統</h1>
              <p className="text-xs text-blue-200">管理部數位化專案</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setActiveTab('form')}
              className={`px - 4 py - 2 rounded - md transition - colors ${activeTab === 'form' ? 'bg-blue-700 text-white font-medium' : 'hover:bg-blue-800 text-blue-200'} `}
            >
              申請表單
            </button>
            <button
              onClick={() => setActiveTab('list')}
              className={`px - 4 py - 2 rounded - md transition - colors flex items - center gap - 2 ${activeTab === 'list' ? 'bg-blue-700 text-white font-medium' : 'hover:bg-blue-800 text-blue-200'} `}
            >
              <History className="w-4 h-4" />
              申請紀錄
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">

        {activeTab === 'form' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Left: The Form */}
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-blue-600" />
                  <h2 className="font-semibold text-slate-700">基本資料填寫</h2>
                </div>

                <form onSubmit={handleSubmit} className="p-6 space-y-6">
                  {/* Row 1: Applicants */}
                  <div className="bg-blue-50/50 p-4 rounded-lg border border-blue-100">
                    <label className="block text-sm font-medium text-slate-700 mb-2 flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-blue-600" />
                        出差人員名單 ({formData.applicants.length}人)
                      </span>
                      <button
                        type="button"
                        onClick={addApplicant}
                        className="text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 px-2 py-1 rounded-md flex items-center gap-1 transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                        新增人員
                      </button>
                    </label>

                    <div className="space-y-3">
                      {formData.applicants.map((name, index) => (
                        <div key={index} className="flex gap-2">
                          <div className="relative flex-1">
                            <User className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                            <input
                              required
                              type="text"
                              value={name}
                              onChange={(e) => handleApplicantChange(index, e.target.value)}
                              placeholder={`出差人員 ${index + 1} `}
                              className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                          </div>
                          {formData.applicants.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeApplicant(index)}
                              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                            >
                              <Trash2 className="w-5 h-5" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">出差日期</label>
                      <input
                        required
                        type="date"
                        name="date"
                        value={formData.date}
                        onChange={handleInputChange}
                        className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">出差地址</label>

                      {/* Location Select */}
                      <div className="mb-2 relative">
                        <Map className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
                        <select
                          onChange={handleLocationSelect}
                          className="w-full pl-10 pr-4 py-2 border border-slate-300 bg-slate-50 rounded-lg text-sm text-slate-700 focus:ring-2 focus:ring-blue-500 outline-none appearance-none cursor-pointer"
                          defaultValue=""
                        >
                          <option value="" disabled>快速帶入常用地點...</option>
                          {Object.keys(LOCATION_GROUPS).map(region => (
                            <optgroup key={region} label={region}>
                              {LOCATION_GROUPS[region].map(loc => (
                                <option key={loc.name} value={loc.name}>
                                  {loc.name} ({loc.hours}H)
                                </option>
                              ))}
                            </optgroup>
                          ))}
                          <option value="custom">其他地點 (手動輸入)</option>
                        </select>
                        <div className="absolute right-3 top-3 pointer-events-none text-slate-400">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                        </div>
                      </div>

                      <div className="relative">
                        <MapPin className="absolute left-3 top-2.5 w-5 h-5 text-slate-400" />
                        <input
                          required
                          type="text"
                          name="destination"
                          value={formData.destination}
                          onChange={handleInputChange}
                          placeholder="請輸入完整地點"
                          className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 2 */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">出差事由</label>
                    <input
                      required
                      type="text"
                      name="reason"
                      value={formData.reason}
                      onChange={handleInputChange}
                      placeholder="例：客戶機台維修、專案會議"
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>

                  <div className="border-t border-slate-100 my-4"></div>

                  {/* Time Section */}
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    時間與行程 (津貼計算依據)
                  </h3>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-blue-50 p-4 rounded-lg border border-blue-100">
                    <div>
                      <label className="block text-xs font-medium text-blue-800 mb-1">出發時間 (24h)</label>
                      <input
                        required
                        type="time"
                        name="startTime"
                        value={formData.startTime}
                        onChange={handleInputChange}
                        className="w-full px-4 py-2 border border-blue-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                      <p className="text-xs text-blue-600 mt-1">* 05:00 前(含)出發有加給</p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-blue-800 mb-1">返回/到廠時間 (24h)</label>
                      <input
                        required
                        type="time"
                        name="endTime"
                        value={formData.endTime}
                        onChange={handleInputChange}
                        className="w-full px-4 py-2 border border-blue-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                      <p className="text-xs text-blue-600 mt-1">* 21:00 後抵達有加給</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">單趟車程 (Google Maps)</label>
                      <div className="relative">
                        <input
                          required
                          type="number"
                          step="0.1"
                          min="0"
                          name="oneWayHours"
                          value={formData.oneWayHours || ''}
                          onChange={handleInputChange}
                          placeholder="小時"
                          className="w-full pr-12 pl-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                        <span className="absolute right-3 top-2 text-slate-500 text-sm">小時</span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">選擇地點後自動帶入，每1.5小時補助$30</p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">過夜天數</label>
                      <div className="relative">
                        <Moon className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                        <input
                          required
                          type="number"
                          min="0"
                          name="nights"
                          value={formData.nights}
                          onChange={handleInputChange}
                          className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="pt-4">
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-lg shadow-md transition-all flex justify-center items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isSubmitting ? (
                        <span>處理中...</span>
                      ) : (
                        <>
                          <CheckCircle2 className="w-5 h-5" />
                          提交 {formData.applicants.length} 人申請單
                        </>
                      )}
                    </button>
                    <p className="text-center text-xs text-slate-400 mt-2">
                      提交後資料將自動同步至管理部 (小井)
                    </p>
                  </div>

                </form>
              </div>
            </div>

            {/* Right: Live Preview & Policy Check */}
            <div className="space-y-6">

              {/* Calculation Card */}
              <div className="bg-white rounded-xl shadow-lg border border-blue-100 overflow-hidden sticky top-24">
                <div className="bg-gradient-to-r from-blue-600 to-blue-800 p-6 text-white">
                  <h3 className="text-lg font-medium opacity-90 flex items-center gap-2">
                    <Calculator className="w-5 h-5" />
                    預估津貼總額
                  </h3>
                  <div className="flex items-end gap-2 mt-2">
                    <div className="text-4xl font-bold">
                      {formatCurrency(calculation.grandTotal)}
                    </div>
                    <div className="text-sm text-blue-200 mb-1">
                      / 共 {calculation.headcount} 人
                    </div>
                  </div>
                </div>

                <div className="p-6 space-y-4">
                  {/* Fatigue */}
                  <div className="py-2 border-b border-slate-100">
                    <div className="flex justify-between items-center mb-1">
                      <div className="text-slate-600 text-sm font-medium">高疲勞值津貼</div>
                      <div className="font-mono font-bold text-slate-800">{formatCurrency(calculation.fatigueTotal)}</div>
                    </div>
                    <div className="text-xs text-slate-400 flex justify-between">
                      <span>依人頭計算 ({calculation.headcount}人)</span>
                      <span>每人 {formatCurrency(calculation.perPersonFatigue)}</span>
                    </div>
                    {(calculation.perPersonFatigue > 0 && formData.startTime.startsWith('05:0')) && (
                      <div className="text-xs text-green-600 mt-1 bg-green-50 p-1 rounded">
                        ✓ 已包含 05:00 出發津貼
                      </div>
                    )}
                  </div>

                  {/* Travel (Car) */}
                  <div className="py-2 border-b border-slate-100">
                    <div className="flex justify-between items-center mb-1">
                      <div className="text-slate-600 text-sm font-medium">車程加給 <span className="text-xs text-slate-400">(來回)</span></div>
                      <div className="font-mono font-bold text-slate-800">{formatCurrency(calculation.travelTotal)}</div>
                    </div>
                    <div className="text-xs text-slate-400 flex justify-between">
                      <span>總額均分 ({calculation.headcount}人)</span>
                      <span className="text-blue-600 font-medium">每人 {formatCurrency(calculation.perPersonTravel)}</span>
                    </div>
                  </div>

                  {/* Overnight */}
                  <div className="py-2 border-b border-slate-100">
                    <div className="flex justify-between items-center mb-1">
                      <div className="text-slate-600 text-sm font-medium">跨日津貼</div>
                      <div className="font-mono font-bold text-slate-800">{formatCurrency(calculation.overnightTotal)}</div>
                    </div>
                    <div className="text-xs text-slate-400 flex justify-between">
                      <span>依人頭計算 ({calculation.headcount}人)</span>
                      <span>每人 {formatCurrency(calculation.perPersonOvernight)}</span>
                    </div>
                  </div>
                </div>

                {/* Policy Alerts */}
                <div className="bg-slate-50 p-4 border-t border-slate-200 space-y-3">
                  {calculation.lateStart && (
                    <div className="flex items-start gap-2 text-amber-700 bg-amber-50 p-3 rounded-md text-sm border border-amber-200">
                      <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                      <div>
                        <span className="font-bold block">符合延後上班政策</span>
                        返回時間晚於 21:00，所有出差人員隔日皆可延後上班 (需通知主管)。
                      </div>
                    </div>
                  )}

                  {calculation.rest > 0 && (
                    <div className="flex items-start gap-2 text-green-700 bg-green-50 p-3 rounded-md text-sm border border-green-200">
                      <Car className="w-5 h-5 flex-shrink-0 mt-0.5" />
                      <div>
                        <span className="font-bold block">駕駛休息權益</span>
                        單程可有 <span className="font-bold">{calculation.rest} 分鐘</span> 帶薪休息。
                      </div>
                    </div>
                  )}
                </div>
              </div>

            </div>
          </div>
        )}

        {/* List View (Admin View for Little Jing) */}
        {activeTab === 'list' && (() => {
          // 計算所有有資料的月份（含當前月）
          const monthsWithData = Array.from(
            new Set(history.map(item => item.date?.substring(0, 7)).filter(Boolean))
          ).sort((a, b) => b.localeCompare(a));

          // 確保當前月一定在清單內
          const now = new Date();
          const currentMonthStr = `${now.getFullYear()} -${String(now.getMonth() + 1).padStart(2, '0')} `;
          if (!monthsWithData.includes(currentMonthStr)) monthsWithData.unshift(currentMonthStr);

          const filteredHistory = history.filter(item => item.date?.startsWith(selectedMonth));
          const monthTotal = filteredHistory.reduce((sum, item) => sum + (item.grandTotal || 0), 0);

          const formatMonth = (ym: string) => {
            const [y, m] = ym.split('-');
            return `${y} 年 ${parseInt(m)} 月`;
          };

          return (
            <div className="flex gap-6">
              {/* Sidebar: Month selector */}
              <div className="w-36 flex-shrink-0">
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden sticky top-24">
                  <div className="bg-slate-50 px-3 py-3 border-b border-slate-200">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">選擇月份</p>
                  </div>
                  <div className="py-1">
                    {monthsWithData.map(ym => {
                      const count = history.filter(h => h.date?.startsWith(ym)).length;
                      const isSelected = ym === selectedMonth;
                      return (
                        <button
                          key={ym}
                          onClick={() => setSelectedMonth(ym)}
                          className={`w - full text - left px - 3 py - 2.5 text - sm transition - colors ${isSelected
                              ? 'bg-blue-600 text-white font-semibold'
                              : 'text-slate-700 hover:bg-slate-50'
                            } `}
                        >
                          <div className={isSelected ? 'text-white' : 'text-slate-800'}>
                            {formatMonth(ym)}
                          </div>
                          <div className={`text - xs mt - 0.5 ${isSelected ? 'text-blue-200' : 'text-slate-400'} `}>
                            {count > 0 ? `${count} 筆` : '尚無資料'}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Main content */}
              <div className="flex-1 min-w-0">
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                  <div className="flex justify-between items-center mb-6">
                    <div>
                      <h2 className="text-xl font-bold text-slate-800">出差津貼彙總表</h2>
                      <p className="text-sm text-slate-500">{formatMonth(selectedMonth)}　供管理部 (小井) 月結使用</p>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-slate-500">本月累積申請金額</div>
                      <div className="text-2xl font-bold text-blue-600">
                        {formatCurrency(monthTotal)}
                      </div>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left text-slate-600">
                      <thead className="text-xs text-slate-700 uppercase bg-slate-50 border-b border-slate-200">
                        <tr>
                          <th className="px-4 py-3">日期</th>
                          <th className="px-4 py-3">出差人員 (多位)</th>
                          <th className="px-4 py-3">地點</th>
                          <th className="px-4 py-3 text-right">疲勞 (總額)</th>
                          <th className="px-4 py-3 text-right">車程 (總額)</th>
                          <th className="px-4 py-3 text-right">跨日 (總額)</th>
                          <th className="px-4 py-3 text-right font-bold text-slate-900">總計</th>
                          <th className="px-4 py-3 text-center">狀態</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredHistory.length === 0 ? (
                          <tr>
                            <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                              {formatMonth(selectedMonth)} 尚無申請資料
                            </td>
                          </tr>
                        ) : (
                          filteredHistory.map((item) => (
                            <tr key={item.id} className="bg-white border-b hover:bg-slate-50">
                              <td className="px-4 py-3 font-medium text-slate-900">{item.date}</td>
                              <td className="px-4 py-3">
                                <div className="font-medium text-slate-800">
                                  {item.applicants?.join(', ') || item.applicantName /* fallback */}
                                </div>
                                <div className="text-xs text-slate-400">共 {item.passengers} 人</div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="font-medium">{item.destination}</div>
                                <div className="text-xs text-slate-400">{item.reason}</div>
                              </td>
                              <td className="px-4 py-3 text-right font-mono">
                                {formatCurrency(item.fatigueAllowanceTotal || item.fatigueAllowance)}
                              </td>
                              <td className="px-4 py-3 text-right font-mono">
                                {formatCurrency(item.travelAllowanceTotal || item.travelAllowance)}
                              </td>
                              <td className="px-4 py-3 text-right font-mono">
                                {formatCurrency(item.overnightAllowanceTotal || item.overnightAllowance)}
                              </td>
                              <td className="px-4 py-3 text-right font-bold text-blue-600 font-mono">
                                {formatCurrency(item.grandTotal || item.totalAmount)}
                              </td>
                              <td className="px-4 py-3 text-center">
                                {item.eligibleForLateStart && (
                                  <span className="inline-block px-2 py-1 text-xs font-semibold text-amber-700 bg-amber-100 rounded-full">
                                    延後上班
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

      </main>
    </div>
  );
}