import React, { useState, useEffect, useMemo } from 'react';
import { 
  signInAnonymously, 
  onAuthStateChanged,
  User as FirebaseUser
} from 'firebase/auth';

import * as firestore from 'firebase/firestore';

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
  Map as MapIcon,
  LogOut,
  ShieldCheck,
  UserCircle,
  Sparkles,
  Loader2
} from 'lucide-react';

import { GoogleGenAI, Type } from "@google/genai";

import { auth, db, APP_ID, isDemoMode } from './services/firebase';
import { PREDEFINED_LOCATIONS, LOCATION_GROUPS, EMPLOYEES } from './constants';
import { TravelRequest, CalculationResult, Employee } from './types';

// Use type casting to avoid "no exported member" errors with some TS/Firebase versions
const { 
  collection, 
  addDoc, 
  onSnapshot, 
  query, 
  orderBy, 
  serverTimestamp
} = firestore as any;

// Define the Admin ID explicitly
const ADMIN_ID = "10608";

// Default origin for driving time calculation
const DEFAULT_ORIGIN = "彰化縣北斗鎮四海路二段79號";

export default function App() {
  // Auth State
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [currentUser, setCurrentUser] = useState<Employee | null>(null);
  const [loginInput, setLoginInput] = useState('');
  const [loginError, setLoginError] = useState('');

  // App State
  const [history, setHistory] = useState<TravelRequest[]>([]);
  const [activeTab, setActiveTab] = useState<'form' | 'my_history' | 'admin'>('form');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // AI State
  const [isEstimating, setIsEstimating] = useState(false);

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

  // --- Initialize & Auth ---
  useEffect(() => {
    // Check local storage for existing session
    const storedUser = localStorage.getItem('travel_app_user');
    if (storedUser) {
      setCurrentUser(JSON.parse(storedUser));
    }

    // DEMO MODE: Skip Firebase Auth
    if (isDemoMode) {
      console.log("App running in Demo Mode");
      setFirebaseUser({ uid: 'demo-user', isAnonymous: true } as FirebaseUser);
      return;
    }

    // REAL MODE: Connect to Firebase
    const initAuth = async () => {
      try {
        await signInAnonymously(auth);
      } catch (err: any) {
        console.error("Auth Error:", err);
        setAuthError("無法連接至資料庫，請檢查網路或系統設定。");
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setFirebaseUser);
    return () => unsubscribe();
  }, []);

  // Update applicant list when user logs in
  useEffect(() => {
    if (currentUser) {
      setFormData(prev => ({
        ...prev,
        applicants: [currentUser.name] // Auto-fill logged in user
      }));
    }
  }, [currentUser]);

  // --- Fetch Data ---
  useEffect(() => {
    // DEMO MODE: Load from LocalStorage
    if (isDemoMode) {
      const savedData = localStorage.getItem('travel_allowance_demo_data');
      if (savedData) {
        try {
          setHistory(JSON.parse(savedData));
        } catch (e) {
          console.error("Failed to parse local data");
        }
      }
      return;
    }

    // REAL MODE: Firebase Snapshot
    if (!firebaseUser) return;
    
    // Construct path: artifacts/{APP_ID}/public/data/travel_allowances
    const q = query(
      collection(db, 'artifacts', APP_ID, 'public', 'data', 'travel_allowances'),
      orderBy('timestamp', 'desc')
    );
    
    const unsubscribeSnapshot = onSnapshot(q, (snapshot: any) => {
      const docs = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() } as TravelRequest));
      setHistory(docs);
    }, (error: any) => {
      console.error("Firestore Error:", error);
    });
    
    return () => unsubscribeSnapshot();
  }, [firebaseUser]);

  // --- Login Logic ---
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedInput = loginInput.trim();
    if (!trimmedInput) return;

    // Search by ID or Name
    const foundEmployee = EMPLOYEES.find(
      emp => emp.id === trimmedInput || emp.name === trimmedInput
    );

    if (foundEmployee) {
      setCurrentUser(foundEmployee);
      localStorage.setItem('travel_app_user', JSON.stringify(foundEmployee));
      setLoginError('');
      setLoginInput('');
      setActiveTab('form');
    } else {
      setLoginError('找不到此員工資料，請確認輸入正確的編號或姓名。');
    }
  };

  const handleLogout = () => {
    setCurrentUser(null);
    localStorage.removeItem('travel_app_user');
    setFormData(prev => ({ ...prev, applicants: [''] }));
    setActiveTab('form'); // Reset tab to avoid staying on admin page
  };

  // --- Business Logic Calculation ---
  const calculation: CalculationResult = useMemo(() => {
    let singlePersonFatigue = 0;
    let carTotalAllowance = 0;
    let singlePersonOvernight = 0;
    
    let isLateStartEligible = false;
    let restTime = 0;

    const headcount = Math.max(1, formData.applicants.length);

    // 1. Fatigue Calculation
    const [startH, startM] = formData.startTime.split(':').map(Number);
    const [endH, endM] = formData.endTime.split(':').map(Number);
    
    const startDec = startH + startM / 60;
    const endDec = endH + endM / 60;

    // Rule A: Early Start (<= 05:00)
    if (startDec <= 5) {
      const duration = 8 - startDec;
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

    // 2. Travel Allowance (Car)
    const oneWayHours = formData.oneWayHours;
    const units = Math.floor(oneWayHours / 1.5);
    const singleTripAllowance = units * 30;
    carTotalAllowance = singleTripAllowance * 2; 
    
    // 15 mins rest per 1.5 hours driving
    restTime = Math.floor(oneWayHours / 1.5) * 15;

    // 3. Overnight Allowance
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
    if (!selectedName || selectedName === 'custom') return;

    const location = PREDEFINED_LOCATIONS.find(loc => loc.name === selectedName);
    if (location) {
      setFormData(prev => ({
        ...prev,
        destination: location.name,
        oneWayHours: location.hours
      }));
    }
  };

  // --- AI Estimation Logic ---
  const handleAIEstimate = async () => {
    const userInput = formData.destination;
    if (!userInput || userInput.trim() === '') {
      alert("請先輸入大概的地點名稱（例如：台積電南科）");
      return;
    }

    // Use process.env.API_KEY which is polyfilled by Vite
    const apiKey = process.env.API_KEY; 

    if (!apiKey) {
      alert("API Key 未設定，無法使用 AI 估算功能。");
      return;
    }

    setIsEstimating(true);

    try {
      const ai = new GoogleGenAI({ apiKey: apiKey });
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `User Origin: ${DEFAULT_ORIGIN}. User Destination Input: "${userInput}".
        Task:
        1. Identify the specific, official full address for the destination input in Taiwan.
        2. Estimate the one-way driving time by car (in hours) from the Origin to this Destination.
        
        Requirements:
        - Use Google Search to find the address and travel time.
        - Return ONLY a JSON object with this schema: { "fullAddress": string, "hours": number }
        - "hours" should be a number (e.g. 1.5).
        - If multiple locations match, pick the most likely major business location.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              fullAddress: { type: Type.STRING },
              hours: { type: Type.NUMBER }
            }
          },
          tools: [{googleSearch: {}}],
        },
      });

      const resultText = response.text;
      if (resultText) {
        const result = JSON.parse(resultText);
        setFormData(prev => ({
          ...prev,
          destination: result.fullAddress || prev.destination,
          oneWayHours: result.hours || prev.oneWayHours
        }));
      }
    } catch (error) {
      console.error("AI Estimate Error:", error);
      alert("AI 估算失敗，請稍後再試或手動輸入。");
    } finally {
      setIsEstimating(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser && !isDemoMode) return;
    if (!currentUser) return; // Should not happen if UI is correct
    
    if (formData.applicants.some(name => !name.trim())) {
      alert("請填寫所有出差人員姓名");
      return;
    }

    setIsSubmitting(true);

    try {
      const payload: TravelRequest = {
        // Current User Info (Submitter)
        submitterId: currentUser.id,
        submitterName: currentUser.name,

        userId: firebaseUser?.uid || 'demo-uid',
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
        timestamp: isDemoMode ? new Date().toISOString() : serverTimestamp()
      };

      if (isDemoMode) {
        // LocalStorage Save
        const newDoc = { ...payload, id: 'local-' + Date.now() };
        const updatedHistory = [newDoc, ...history];
        setHistory(updatedHistory);
        localStorage.setItem('travel_allowance_demo_data', JSON.stringify(updatedHistory));
        await new Promise(resolve => setTimeout(resolve, 600)); 
      } else {
        // Firebase Save
        await addDoc(collection(db, 'artifacts', APP_ID, 'public', 'data', 'travel_allowances'), payload);
      }
      
      setFormData(prev => ({
        ...prev,
        applicants: [currentUser.name], // Reset to just current user
        reason: '',
        destination: '',
        startTime: '08:00',
        endTime: '17:00',
        oneWayHours: 0,
        nights: 0
      }));
      
      setActiveTab('my_history');
      window.scrollTo(0, 0);
    } catch (error) {
      console.error("Error:", error);
      alert("提交失敗，請稍後再試。");
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', minimumFractionDigits: 0 }).format(val);
  };

  // --- Render: Login Screen ---
  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-xl shadow-xl max-w-sm w-full border border-slate-200">
          <div className="text-center mb-6">
            <div className="bg-blue-600 w-12 h-12 rounded-lg flex items-center justify-center mx-auto mb-4">
              <Car className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">遠地出差津貼申請系統</h1>
            <p className="text-slate-500 text-sm mt-1">請登入系統以開始使用</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">員工編號或姓名</label>
              <div className="relative">
                <UserCircle className="absolute left-3 top-2.5 w-5 h-5 text-slate-400" />
                <input 
                  type="text" 
                  value={loginInput}
                  onChange={(e) => setLoginInput(e.target.value)}
                  placeholder="例：7904 或 胡淑惠"
                  className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
                  autoFocus
                />
              </div>
            </div>

            {loginError && (
              <div className="text-red-500 text-sm bg-red-50 p-2 rounded border border-red-100 flex items-center gap-1">
                <AlertCircle className="w-4 h-4" />
                {loginError}
              </div>
            )}

            <button 
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg transition-colors"
            >
              登入系統
            </button>
          </form>
          
          {authError && !isDemoMode && (
             <p className="mt-4 text-xs text-center text-red-400">{authError}</p>
          )}
        </div>
      </div>
    );
  }

  // --- Render: Main App ---
  const myHistory = history.filter(item => item.submitterId === currentUser.id);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans pb-10">
      
      {/* Header */}
      <header className="bg-blue-900 text-white shadow-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-3">
          {/* Top Bar: Logo & User Info */}
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-3">
              <div className="bg-white/10 p-1.5 rounded-lg">
                <Car className="w-5 h-5 text-yellow-400" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-wide leading-tight">遠地出差津貼申請系統</h1>
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <div className="text-sm font-medium">{currentUser.name}</div>
                <div className="text-xs text-blue-300">員工編號：{currentUser.id}</div>
              </div>
              <button 
                onClick={handleLogout}
                className="bg-blue-800 hover:bg-blue-700 p-2 rounded-full transition-colors text-blue-100"
                title="登出"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex gap-1 overflow-x-auto">
            <button 
              onClick={() => setActiveTab('form')}
              className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap
                ${activeTab === 'form' 
                  ? 'bg-slate-50 text-blue-900' 
                  : 'bg-blue-800/50 text-blue-100 hover:bg-blue-800'}`}
            >
              <FileText className="w-4 h-4" />
              申請表單
            </button>
            <button 
              onClick={() => setActiveTab('my_history')}
              className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap
                ${activeTab === 'my_history' 
                  ? 'bg-slate-50 text-blue-900' 
                  : 'bg-blue-800/50 text-blue-100 hover:bg-blue-800'}`}
            >
              <History className="w-4 h-4" />
              個人紀錄 ({myHistory.length})
            </button>
            
            {/* Admin Tab - Only visible to specific admin ID */}
            {currentUser.id === ADMIN_ID && (
              <button 
                onClick={() => setActiveTab('admin')}
                className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap ml-auto
                  ${activeTab === 'admin' 
                    ? 'bg-slate-50 text-blue-900' 
                    : 'bg-blue-950 text-blue-200 hover:bg-blue-800'}`}
              >
                <ShieldCheck className="w-4 h-4" />
                管理後台
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        
        {activeTab === 'form' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Left: The Form */}
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-blue-600" />
                  <h2 className="font-semibold text-slate-700">新申請單</h2>
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
                        className="text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 px-3 py-1.5 rounded-md flex items-center gap-1 transition-colors font-medium"
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
                              placeholder={`出差人員 ${index + 1}`}
                              className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
                            />
                          </div>
                          {formData.applicants.length > 1 && (
                            <button 
                              type="button"
                              onClick={() => removeApplicant(index)}
                              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                              title="移除此人員"
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
                        className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">出差地址</label>
                      
                      {/* Location Select */}
                      <div className="mb-2 relative">
                         <MapIcon className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
                         <select
                           onChange={handleLocationSelect}
                           className="w-full pl-10 pr-4 py-2 border border-slate-300 bg-white rounded-lg text-sm text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none appearance-none cursor-pointer"
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
                        <div className="relative">
                          <input 
                            required
                            type="text" 
                            name="destination"
                            value={formData.destination}
                            onChange={handleInputChange}
                            placeholder="輸入地點後點擊右側 AI 估算..."
                            className="w-full pl-10 pr-28 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
                          />
                          <button
                            type="button"
                            onClick={handleAIEstimate}
                            disabled={isEstimating}
                            className="absolute right-1.5 top-1.5 bottom-1.5 px-3 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold rounded-md flex items-center gap-1.5 transition-colors border border-indigo-200"
                            title="使用 AI 搜尋完整地址並估算車程 (以台中為起點)"
                          >
                            {isEstimating ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Sparkles className="w-3.5 h-3.5" />
                            )}
                            AI 估算
                          </button>
                        </div>
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
                      className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
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
                        className="w-full px-4 py-2 border border-blue-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
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
                        className="w-full px-4 py-2 border border-blue-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
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
                          className="w-full pr-12 pl-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
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
                          className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
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

        {/* My History (Personal Record) */}
        {activeTab === 'my_history' && (
          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h2 className="text-xl font-bold text-slate-800">個人申請紀錄</h2>
                  <p className="text-sm text-slate-500">申請人：{currentUser.name} ({currentUser.id})</p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left text-slate-600">
                  <thead className="text-xs text-slate-700 uppercase bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 whitespace-nowrap">日期</th>
                      <th className="px-4 py-3 whitespace-nowrap">出差人員</th>
                      <th className="px-4 py-3 whitespace-nowrap">地點</th>
                      <th className="px-4 py-3 text-right whitespace-nowrap">總金額</th>
                      <th className="px-4 py-3 text-center whitespace-nowrap">狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myHistory.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                          尚無申請資料
                        </td>
                      </tr>
                    ) : (
                      myHistory.map((item) => (
                        <tr key={item.id} className="bg-white border-b hover:bg-slate-50">
                          <td className="px-4 py-3 font-medium text-slate-900 whitespace-nowrap">{item.date}</td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-800">
                              {item.applicants?.join(', ') || 'N/A'}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium">{item.destination}</div>
                            <div className="text-xs text-slate-400">{item.reason}</div>
                          </td>
                          <td className="px-4 py-3 text-right font-bold text-blue-600 font-mono">
                            {formatCurrency(item.grandTotal)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="inline-block px-2 py-1 text-xs font-semibold text-green-700 bg-green-100 rounded-full">
                              已提交
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Admin Dashboard (Full Records) */}
        {activeTab === 'admin' && currentUser.id === ADMIN_ID && (
          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h2 className="text-xl font-bold text-slate-800">出差津貼彙總表</h2>
                  <p className="text-sm text-slate-500">供管理部 (小井) 月結使用</p>
                </div>
                <div className="text-right">
                  <div className="text-sm text-slate-500">本期累積申請金額</div>
                  <div className="text-2xl font-bold text-blue-600">
                    {formatCurrency(history.reduce((sum, item) => sum + (item.grandTotal || 0), 0))}
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left text-slate-600">
                  <thead className="text-xs text-slate-700 uppercase bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 whitespace-nowrap">提交人</th>
                      <th className="px-4 py-3 whitespace-nowrap">日期</th>
                      <th className="px-4 py-3 whitespace-nowrap">出差人員</th>
                      <th className="px-4 py-3 whitespace-nowrap">地點</th>
                      <th className="px-4 py-3 text-right whitespace-nowrap">疲勞</th>
                      <th className="px-4 py-3 text-right whitespace-nowrap">車程</th>
                      <th className="px-4 py-3 text-right whitespace-nowrap">跨日</th>
                      <th className="px-4 py-3 text-right font-bold text-slate-900 whitespace-nowrap">總計</th>
                      <th className="px-4 py-3 text-center whitespace-nowrap">狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-slate-400">
                          目前尚無申請資料
                        </td>
                      </tr>
                    ) : (
                      history.map((item) => (
                        <tr key={item.id} className="bg-white border-b hover:bg-slate-50">
                          <td className="px-4 py-3 whitespace-nowrap">
                             <div className="font-medium text-slate-900">{item.submitterName || '未知'}</div>
                             <div className="text-xs text-slate-400">{item.submitterId}</div>
                          </td>
                          <td className="px-4 py-3 font-medium text-slate-900 whitespace-nowrap">{item.date}</td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-800">
                              {item.applicants?.join(', ') || 'N/A'}
                            </div>
                            <div className="text-xs text-slate-400">共 {item.passengers} 人</div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium">{item.destination}</div>
                            <div className="text-xs text-slate-400">{item.reason}</div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono">
                            {formatCurrency(item.fatigueAllowanceTotal)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono">
                            {formatCurrency(item.travelAllowanceTotal)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono">
                            {formatCurrency(item.overnightAllowanceTotal)}
                          </td>
                          <td className="px-4 py-3 text-right font-bold text-blue-600 font-mono">
                            {formatCurrency(item.grandTotal)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {item.eligibleForLateStart && (
                              <span className="inline-block px-2 py-1 text-xs font-semibold text-amber-700 bg-amber-100 rounded-full whitespace-nowrap">
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
        )}

      </main>
    </div>
  );
}