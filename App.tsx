import { useState, useEffect, useMemo } from 'react';
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
  Loader2,
  Download,
  Calendar
} from 'lucide-react';

// Removed direct import of @google/generative-ai to avoid bundling issues on Vercel.

import { auth, db, APP_ID, isDemoMode } from './services/firebase';
import { PREDEFINED_LOCATIONS, LOCATION_GROUPS, EMPLOYEES } from './constants';
import { TravelRequest, CalculationResult, Employee, Destination, DayEntry } from './types';

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

// Add N days to a YYYY-MM-DD date string (local time, DST-safe)
const addDays = (dateStr: string, days: number): string => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

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

  // Export State
  const [exportMonth, setExportMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  // Form State
  const [formData, setFormData] = useState<{
    applicants: string[];
    reason: string;
    destinations: Destination[];
    effectiveOneWayHours: number;
    date: string;
    startTime: string;
    endTime: string;
    nights: number;
    dayEntries: DayEntry[];
  }>({
    applicants: [''],
    reason: '',
    destinations: [{ address: '', oneWayHours: 0 }],
    effectiveOneWayHours: 0,
    date: new Date().toISOString().split('T')[0],
    startTime: '08:00',
    endTime: '17:00',
    nights: 0,
    dayEntries: [],
  });

  // Track which destination is focused for location selector / AI estimate
  const [focusedDestinationIndex, setFocusedDestinationIndex] = useState(0);

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

  // When base date changes, refresh dates in dayEntries (keep times unchanged)
  useEffect(() => {
    setFormData(prev => {
      if (prev.nights <= 0 || prev.dayEntries.length === 0) return prev;
      return {
        ...prev,
        dayEntries: prev.dayEntries.map((entry, i) => ({
          ...entry,
          date: addDays(prev.date, i),
        })),
      };
    });
  }, [formData.date]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // --- Applicant Autocomplete ---
  const [activeApplicantIndex, setActiveApplicantIndex] = useState<number | null>(null);
  const [showApplicantSuggestions, setShowApplicantSuggestions] = useState(false);
  const applicantSuggestions = useMemo(() => {
    if (activeApplicantIndex === null) return [];
    const trimmed = formData.applicants[activeApplicantIndex]?.trim() || '';
    if (!trimmed) return [];
    return EMPLOYEES.filter(
      emp => emp.name.includes(trimmed) || emp.id.includes(trimmed)
    );
  }, [formData.applicants, activeApplicantIndex]);

  const handleSelectApplicantSuggestion = (emp: Employee, index: number) => {
    const newApplicants = [...formData.applicants];
    newApplicants[index] = emp.name;
    setFormData(prev => ({ ...prev, applicants: newApplicants }));
    setShowApplicantSuggestions(false);
    setActiveApplicantIndex(null);
  };

  // --- Login Suggestions (autocomplete) ---
  const [showSuggestions, setShowSuggestions] = useState(false);
  const loginSuggestions = useMemo(() => {
    const trimmed = loginInput.trim();
    if (!trimmed) return [];
    return EMPLOYEES.filter(
      emp => emp.name.includes(trimmed) || emp.id.includes(trimmed)
    );
  }, [loginInput]);

  const handleSelectSuggestion = (emp: Employee) => {
    setLoginInput(emp.name);
    setShowSuggestions(false);
    setCurrentUser(emp);
    localStorage.setItem('travel_app_user', JSON.stringify(emp));
    setLoginError('');
    setLoginInput('');
    setActiveTab('form');
  };

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
    setFormData(prev => ({ ...prev, applicants: [''], destinations: [{ address: '', oneWayHours: 0 }], effectiveOneWayHours: 0 }));
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
    const calcDayFatigue = (startTime: string, endTime: string) => {
      const [startH, startM] = startTime.split(':').map(Number);
      const [endH, endM] = endTime.split(':').map(Number);
      const startDec = startH + startM / 60;
      const endDec = endH + endM / 60;
      let fatigue = 0;
      // Rule A: Early Start (<= 05:00)
      if (startDec <= 5) {
        fatigue += Math.floor((8 - startDec) * 2) / 2 * 200;
      }
      // Rule B: Late Arrival (> 21:00)
      if (endDec > 21) {
        isLateStartEligible = true;
        fatigue += Math.floor((endDec - 21) * 2) / 2 * 200;
      }
      return fatigue;
    };

    if (formData.nights > 0 && formData.dayEntries.length > 0) {
      // Multi-day: sum fatigue from each day's entries
      for (const entry of formData.dayEntries) {
        singlePersonFatigue += calcDayFatigue(entry.startTime, entry.endTime);
      }
    } else {
      // Single day
      singlePersonFatigue = calcDayFatigue(formData.startTime, formData.endTime);
    }

    // 2. Travel Allowance (Car) - based on effective one-way hours (max of all destinations)
    const oneWayHours = formData.effectiveOneWayHours;
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
      headcount,
      travelUnits: units,
      singleTripAllowance,
    };

  }, [formData.startTime, formData.endTime, formData.effectiveOneWayHours, formData.applicants.length, formData.nights, formData.dayEntries]);

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

  const handleDayEntryChange = (index: number, field: 'startTime' | 'endTime', value: string) => {
    setFormData(prev => {
      const newEntries = [...prev.dayEntries];
      newEntries[index] = { ...newEntries[index], [field]: value };
      return { ...prev, dayEntries: newEntries };
    });
  };

  const handleNightsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nights = Math.max(0, Number(e.target.value));
    setFormData(prev => {
      const totalDays = nights + 1;
      let newEntries: DayEntry[];
      if (nights === 0) {
        newEntries = [];
      } else {
        newEntries = Array.from({ length: totalDays }, (_, i) => {
          // Preserve existing entry if it already exists
          if (prev.dayEntries[i]) {
            return { ...prev.dayEntries[i], date: addDays(prev.date, i) };
          }
          return {
            date: addDays(prev.date, i),
            startTime: i === 0 ? prev.startTime : '08:00',
            endTime: i === totalDays - 1 ? prev.endTime : '17:00',
          };
        });
      }
      return { ...prev, nights, dayEntries: newEntries };
    });
  };

  // --- Destination Handlers ---
  const handleDestinationChange = (index: number, field: keyof Destination, value: string | number) => {
    setFormData(prev => {
      const newDests = [...prev.destinations];
      newDests[index] = { ...newDests[index], [field]: value };
      const maxHours = Math.max(...newDests.map(d => d.oneWayHours), 0);
      return { ...prev, destinations: newDests, effectiveOneWayHours: maxHours };
    });
  };

  const addDestination = () => {
    setFormData(prev => ({
      ...prev,
      destinations: [...prev.destinations, { address: '', oneWayHours: 0 }],
    }));
    setFocusedDestinationIndex(formData.destinations.length);
  };

  const removeDestination = (index: number) => {
    if (formData.destinations.length <= 1) return;
    setFormData(prev => {
      const newDests = prev.destinations.filter((_, i) => i !== index);
      const maxHours = Math.max(...newDests.map(d => d.oneWayHours), 0);
      return { ...prev, destinations: newDests, effectiveOneWayHours: maxHours };
    });
    setFocusedDestinationIndex(0);
  };

  const handleLocationSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedName = e.target.value;
    if (!selectedName || selectedName === 'custom') return;

    const location = PREDEFINED_LOCATIONS.find(loc => loc.name === selectedName);
    if (location) {
      setFormData(prev => {
        const newDests = [...prev.destinations];
        newDests[focusedDestinationIndex] = { address: location.name, oneWayHours: location.hours };
        const maxHours = Math.max(...newDests.map(d => d.oneWayHours), 0);
        return { ...prev, destinations: newDests, effectiveOneWayHours: maxHours };
      });
    }
  };

  // --- AI Estimation Logic ---
  const handleAIEstimate = async (overrideIndex?: number) => {
    const idx = overrideIndex ?? focusedDestinationIndex;
    const dest = formData.destinations[idx];
    const userInput = dest?.address;
    if (!userInput || userInput.trim() === '') {
      alert("請先輸入大概的地點名稱（例如：台積電南科）");
      return;
    }

    setIsEstimating(true);

    try {
      const resp = await fetch('/api/ai-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: userInput, origin: DEFAULT_ORIGIN })
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(txt || 'AI estimate failed');
      }

      const result = await resp.json();
      setFormData(prev => {
        const newDests = [...prev.destinations];
        newDests[idx] = {
          address: result.fullAddress || dest.address,
          oneWayHours: result.hours || dest.oneWayHours
        };
        const maxHours = Math.max(...newDests.map(d => d.oneWayHours), 0);
        return { ...prev, destinations: newDests, effectiveOneWayHours: maxHours };
      });

    } catch (error) {
      console.error("AI Estimate Error:", error);
      alert("AI 估算失敗，請稍後再試或手動輸入。\n(確保已在 Vercel 設定 GOOGLE_MAPS_API_KEY)");
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
        date: formData.date,
        startTime: formData.nights > 0 && formData.dayEntries.length > 0
          ? formData.dayEntries[0].startTime
          : formData.startTime,
        endTime: formData.nights > 0 && formData.dayEntries.length > 0
          ? formData.dayEntries[formData.dayEntries.length - 1].endTime
          : formData.endTime,
        nights: formData.nights,
        dayEntries: formData.nights > 0 ? formData.dayEntries : undefined,

        // Multi-destination
        destinations: formData.destinations,
        effectiveOneWayHours: formData.effectiveOneWayHours,

        // Backward compat legacy fields
        destination: formData.destinations.map(d => d.address).join(' → '),
        oneWayHours: formData.effectiveOneWayHours,
        
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
        applicants: [currentUser.name],
        reason: '',
        destinations: [{ address: '', oneWayHours: 0 }],
        effectiveOneWayHours: 0,
        startTime: '08:00',
        endTime: '17:00',
        nights: 0,
        dayEntries: [],
      }));
      
      // Stay on form tab after submission
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

  const formatTimestamp = (ts: any): string => {
    if (!ts) return '-';
    let date: Date;
    if (typeof ts === 'string') {
      date = new Date(ts);
    } else if (ts.toDate) {
      date = ts.toDate();
    } else if (ts.seconds) {
      date = new Date(ts.seconds * 1000);
    } else {
      return '-';
    }
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    return `${y}/${mo}/${d} ${h}:${mi}`;
  };

  // --- Download Monthly CSV ---
  const downloadMonthlyCSV = () => {
    const [yearStr, monthStr] = exportMonth.split('-');
    const year = parseInt(yearStr);
    const month = parseInt(monthStr);

    // Filter records for the selected month
    const monthRecords = history.filter(item => {
      if (!item.date) return false;
      const [y, m] = item.date.split('-').map(Number);
      return y === year && m === month;
    });

    if (monthRecords.length === 0) {
      alert('該月份無出差紀錄');
      return;
    }

    // Build per-employee-per-date data
    const dateMap: Record<string, Record<string, { fatigue: number; travel: number; overnight: number }>> = {};
    const employeeSet = new Set<string>();

    for (const record of monthRecords) {
      const dateKey = record.date;
      if (!dateMap[dateKey]) dateMap[dateKey] = {};

      const applicants = record.applicants || [];
      const headcount = record.passengers || applicants.length || 1;
      const perFatigue = record.perPersonFatigue ?? (record.fatigueAllowanceTotal / headcount);
      const perTravel = record.perPersonTravel ?? (record.travelAllowanceTotal / headcount);
      const perOvernight = record.perPersonOvernight ?? (record.overnightAllowanceTotal / headcount);

      for (const name of applicants) {
        employeeSet.add(name);
        if (!dateMap[dateKey][name]) {
          dateMap[dateKey][name] = { fatigue: 0, travel: 0, overnight: 0 };
        }
        dateMap[dateKey][name].fatigue += perFatigue;
        dateMap[dateKey][name].travel += perTravel;
        dateMap[dateKey][name].overnight += perOvernight;
      }
    }

    const employees = Array.from(employeeSet).sort();
    const dates = Object.keys(dateMap).sort();

    // Build CSV rows
    const rows: string[][] = [];

    // Row 1: Employee names header (each spans 3 columns)
    const header1 = ['日期'];
    for (const emp of employees) {
      header1.push(emp, '', '');
    }
    header1.push('當日合計');
    rows.push(header1);

    // Row 2: Sub-column headers
    const header2 = [''];
    for (let i = 0; i < employees.length; i++) {
      header2.push('疲勞', '車程', '跨日');
    }
    header2.push('');
    rows.push(header2);

    // Employee totals accumulator
    const empTotals: Record<string, { fatigue: number; travel: number; overnight: number }> = {};
    for (const emp of employees) {
      empTotals[emp] = { fatigue: 0, travel: 0, overnight: 0 };
    }
    let grandTotal = 0;

    // Data rows
    for (const dateKey of dates) {
      const [, m, d] = dateKey.split('-').map(Number);
      const dateLabel = `${m}/${d}`;
      const row = [dateLabel];
      let dayTotal = 0;

      for (const emp of employees) {
        const data = dateMap[dateKey][emp];
        if (data) {
          row.push(
            data.fatigue ? String(Math.round(data.fatigue)) : '',
            data.travel ? String(Math.round(data.travel)) : '',
            data.overnight ? String(Math.round(data.overnight)) : ''
          );
          const personDay = data.fatigue + data.travel + data.overnight;
          dayTotal += personDay;
          empTotals[emp].fatigue += data.fatigue;
          empTotals[emp].travel += data.travel;
          empTotals[emp].overnight += data.overnight;
        } else {
          row.push('', '', '');
        }
      }
      row.push(dayTotal ? String(Math.round(dayTotal)) : '');
      grandTotal += dayTotal;
      rows.push(row);
    }

    // Totals row
    const totalRow = ['合計'];
    for (const emp of employees) {
      const t = empTotals[emp];
      totalRow.push(
        t.fatigue ? String(Math.round(t.fatigue)) : '',
        t.travel ? String(Math.round(t.travel)) : '',
        t.overnight ? String(Math.round(t.overnight)) : ''
      );
    }
    totalRow.push(String(Math.round(grandTotal)));
    rows.push(totalRow);

    // Empty row + Grand total row
    const colCount = header1.length;
    rows.push(new Array(colCount).fill(''));
    const grandRow = new Array(colCount).fill('');
    grandRow[0] = '總計';
    grandRow[colCount - 1] = String(Math.round(grandTotal));
    rows.push(grandRow);

    // Generate CSV with BOM for Excel
    const csvContent = '\uFEFF' + rows.map(row =>
      row.map(cell => {
        if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
          return `"${cell.replace(/"/g, '""')}"`;
        }
        return cell;
      }).join(',')
    ).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `出差津貼總表_${year}年${month}月.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
                  onChange={(e) => { setLoginInput(e.target.value); setShowSuggestions(true); }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                  placeholder="例：7904 或 胡淑惠"
                  className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
                  autoFocus
                  autoComplete="off"
                />
                {showSuggestions && loginSuggestions.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {loginSuggestions.map(emp => (
                      <button
                        key={emp.id}
                        type="button"
                        onMouseDown={() => handleSelectSuggestion(emp)}
                        className="w-full text-left px-4 py-2 hover:bg-blue-50 flex justify-between items-center text-sm"
                      >
                        <span className="font-medium text-slate-800">{emp.name}</span>
                        <span className="text-slate-400 text-xs">編號 {emp.id}</span>
                      </button>
                    ))}
                  </div>
                )}
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
  const myHistory = history.filter(item =>
    item.submitterId === currentUser.id ||
    item.applicants?.includes(currentUser.name)
  );

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
                              onChange={(e) => {
                                handleApplicantChange(index, e.target.value);
                                setActiveApplicantIndex(index);
                                setShowApplicantSuggestions(true);
                              }}
                              onFocus={() => {
                                setActiveApplicantIndex(index);
                                setShowApplicantSuggestions(true);
                              }}
                              onBlur={() => setTimeout(() => setShowApplicantSuggestions(false), 200)}
                              placeholder={`出差人員 ${index + 1}`}
                              className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
                              autoComplete="off"
                            />
                            {showApplicantSuggestions && activeApplicantIndex === index && applicantSuggestions.length > 0 && (
                              <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                                {applicantSuggestions.map(emp => (
                                  <button
                                    key={emp.id}
                                    type="button"
                                    onMouseDown={() => handleSelectApplicantSuggestion(emp, index)}
                                    className="w-full text-left px-4 py-2 hover:bg-blue-50 flex justify-between items-center text-sm"
                                  >
                                    <span className="font-medium text-slate-800">{emp.name}</span>
                                    <span className="text-slate-400 text-xs">編號 {emp.id}</span>
                                  </button>
                                ))}
                              </div>
                            )}
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

                  {/* Multi-Destination Section */}
                  <div className="bg-green-50/50 p-4 rounded-lg border border-green-100">
                    <label className="block text-sm font-medium text-slate-700 mb-2 flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-green-600" />
                        出差地點 ({formData.destinations.length} 個目的地)
                      </span>
                      <button type="button" onClick={addDestination}
                        className="text-xs bg-green-100 text-green-700 hover:bg-green-200 px-3 py-1.5 rounded-md flex items-center gap-1 transition-colors font-medium">
                        <Plus className="w-3 h-3" /> 新增地點
                      </button>
                    </label>

                    {/* Shared location quick-select */}
                    <div className="mb-3 relative">
                      <MapIcon className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
                      <select
                        onChange={handleLocationSelect}
                        className="w-full pl-10 pr-4 py-2 border border-slate-300 bg-white rounded-lg text-sm text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none appearance-none cursor-pointer"
                        defaultValue=""
                      >
                        <option value="" disabled>快速帶入常用地點 → 目的地 {focusedDestinationIndex + 1}...</option>
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

                    <div className="space-y-3">
                      {formData.destinations.map((dest, index) => (
                        <div key={index} className="bg-white p-3 rounded-lg border border-green-200">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded">目的地 {index + 1}</span>
                            {dest.oneWayHours > 0 && (
                              <span className="text-xs text-slate-400">單程 {dest.oneWayHours}H</span>
                            )}
                            {formData.destinations.length > 1 && (
                              <button type="button" onClick={() => removeDestination(index)}
                                className="ml-auto p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors">
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <div className="relative flex-1">
                              <MapPin className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                              <input
                                required
                                type="text"
                                value={dest.address}
                                onFocus={() => setFocusedDestinationIndex(index)}
                                onChange={(e) => handleDestinationChange(index, 'address', e.target.value)}
                                placeholder="地址或地點名稱"
                                className="w-full pl-10 pr-28 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900 text-sm"
                              />
                              <button
                                type="button"
                                onClick={() => { setFocusedDestinationIndex(index); handleAIEstimate(index); }}
                                disabled={isEstimating}
                                className="absolute right-1.5 top-1.5 bottom-1.5 px-3 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold rounded-md flex items-center gap-1.5 transition-colors border border-indigo-200"
                                title="使用 AI 估算車程"
                              >
                                {isEstimating && focusedDestinationIndex === index ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Sparkles className="w-3.5 h-3.5" />
                                )}
                                AI
                              </button>
                            </div>
                            <div className="w-20">
                              <input
                                type="number"
                                step="0.1"
                                min="0"
                                value={dest.oneWayHours || ''}
                                onChange={(e) => handleDestinationChange(index, 'oneWayHours', Number(e.target.value))}
                                placeholder="時數"
                                className="w-full px-2 py-2 border border-slate-300 rounded-lg text-center text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
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
                  
                  {/* 過夜天數 + 單趟車程 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">單趟車程 (取最遠, 可手動覆蓋)</label>
                      <div className="relative">
                        <input
                          required
                          type="number"
                          step="0.1"
                          min="0"
                          value={formData.effectiveOneWayHours || ''}
                          onChange={(e) => setFormData(prev => ({ ...prev, effectiveOneWayHours: Number(e.target.value) }))}
                          placeholder="小時"
                          className="w-full pr-12 pl-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
                        />
                        <span className="absolute right-3 top-2 text-slate-500 text-sm">小時</span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        自動取最遠: {Math.max(...formData.destinations.map(d => d.oneWayHours), 0)}H，每1.5小時補助$30
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">過夜天數</label>
                      <div className="relative">
                        <Moon className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                        <input
                          type="number"
                          min="0"
                          name="nights"
                          value={formData.nights === 0 ? '' : formData.nights}
                          placeholder="0"
                          onChange={handleNightsChange}
                          className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900"
                        />
                      </div>
                      {formData.nights > 0 && (
                        <p className="text-xs text-indigo-600 mt-1">共 {formData.nights + 1} 天，請分別填寫各天時間</p>
                      )}
                    </div>
                  </div>

                  {/* 時間輸入：單日 or 多日 */}
                  {formData.nights > 0 && formData.dayEntries.length > 0 ? (
                    <div className="space-y-3">
                      {formData.dayEntries.map((entry, index) => {
                        const isFirst = index === 0;
                        const isLast = index === formData.nights;
                        const dayLabel = isFirst ? '出發日' : isLast ? '返回日' : `第 ${index + 1} 天`;
                        const [sh, sm] = entry.startTime.split(':').map(Number);
                        const [eh, em] = entry.endTime.split(':').map(Number);
                        const startDec = sh + sm / 60;
                        const endDec = eh + em / 60;
                        return (
                          <div key={index} className="bg-indigo-50 p-4 rounded-lg border border-indigo-200">
                            <p className="text-xs font-bold text-indigo-800 mb-3 flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              第 {index + 1} 天（{dayLabel}）— {entry.date}
                            </p>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-indigo-700 mb-1">出發時間 (24h)</label>
                                <select
                                  value={entry.startTime}
                                  onChange={(e) => handleDayEntryChange(index, 'startTime', e.target.value)}
                                  className="w-full px-3 py-2 border border-indigo-200 rounded-lg focus:ring-2 focus:ring-indigo-400 outline-none bg-white text-slate-900 appearance-none cursor-pointer text-sm"
                                >
                                  {Array.from({ length: 48 }, (_, i) => {
                                    const h = String(Math.floor(i / 2)).padStart(2, '0');
                                    const m = i % 2 === 0 ? '00' : '30';
                                    return <option key={i} value={`${h}:${m}`}>{h}:{m}</option>;
                                  })}
                                </select>
                                {startDec <= 5 && (
                                  <p className="text-xs text-green-600 mt-1">✓ 早出加給 +{formatCurrency(Math.floor((8 - startDec) * 2) / 2 * 200)}/人</p>
                                )}
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-indigo-700 mb-1">收班時間 (24h)</label>
                                <select
                                  value={entry.endTime}
                                  onChange={(e) => handleDayEntryChange(index, 'endTime', e.target.value)}
                                  className="w-full px-3 py-2 border border-indigo-200 rounded-lg focus:ring-2 focus:ring-indigo-400 outline-none bg-white text-slate-900 appearance-none cursor-pointer text-sm"
                                >
                                  {Array.from({ length: 48 }, (_, i) => {
                                    const h = String(Math.floor(i / 2)).padStart(2, '0');
                                    const m = i % 2 === 0 ? '00' : '30';
                                    return <option key={i} value={`${h}:${m}`}>{h}:{m}</option>;
                                  })}
                                </select>
                                {endDec > 21 && (
                                  <p className="text-xs text-amber-600 mt-1">✓ 晚歸加給 +{formatCurrency(Math.floor((endDec - 21) * 2) / 2 * 200)}/人</p>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <p className="text-xs text-slate-400">* 05:00 前(含)出發 / 21:00 後抵達 各天分開計算疲勞加給</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-blue-50 p-4 rounded-lg border border-blue-100">
                      <div>
                        <label className="block text-xs font-medium text-blue-800 mb-1">出發時間 (24h)</label>
                        <select
                          required
                          name="startTime"
                          value={formData.startTime}
                          onChange={handleInputChange}
                          className="w-full px-4 py-2 border border-blue-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900 appearance-none cursor-pointer"
                        >
                          {Array.from({ length: 48 }, (_, i) => {
                            const h = String(Math.floor(i / 2)).padStart(2, '0');
                            const m = i % 2 === 0 ? '00' : '30';
                            return <option key={`s-${i}`} value={`${h}:${m}`}>{h}:{m}</option>;
                          })}
                        </select>
                        <p className="text-xs text-blue-600 mt-1">* 05:00 前(含)出發有加給</p>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-blue-800 mb-1">返回/到廠時間 (24h)</label>
                        <select
                          required
                          name="endTime"
                          value={formData.endTime}
                          onChange={handleInputChange}
                          className="w-full px-4 py-2 border border-blue-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-slate-900 appearance-none cursor-pointer"
                        >
                          {Array.from({ length: 48 }, (_, i) => {
                            const h = String(Math.floor(i / 2)).padStart(2, '0');
                            const m = i % 2 === 0 ? '00' : '30';
                            return <option key={`e-${i}`} value={`${h}:${m}`}>{h}:{m}</option>;
                          })}
                        </select>
                        <p className="text-xs text-blue-600 mt-1">* 21:00 後抵達有加給</p>
                      </div>
                    </div>
                  )}

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
                    {calculation.perPersonFatigue > 0 && (
                       <div className="text-xs text-green-600 mt-1 bg-green-50 p-1 rounded">
                         ✓ 已包含疲勞加給{formData.nights > 0 ? `（共 ${formData.nights + 1} 天合計）` : ''}
                       </div>
                    )}
                  </div>

                  {/* Travel (Car) */}
                  <div className="py-2 border-b border-slate-100">
                    <div className="flex justify-between items-center mb-1">
                      <div className="text-slate-600 text-sm font-medium">車程加給 <span className="text-xs text-slate-400">(來回)</span></div>
                      <div className="font-mono font-bold text-slate-800">{formatCurrency(calculation.travelTotal)}</div>
                    </div>
                    <div className="text-xs text-slate-400 space-y-0.5">
                      <div>單程 {formData.effectiveOneWayHours}H ÷ 1.5 = {calculation.travelUnits} 單位 × $30 = {formatCurrency(calculation.singleTripAllowance)}/趟</div>
                      <div>來回: {formatCurrency(calculation.singleTripAllowance)} × 2 = {formatCurrency(calculation.travelTotal)}</div>
                      <div className="flex justify-between">
                        <span>總額均分 ({calculation.headcount}人)</span>
                        <span className="text-blue-600 font-medium">每人 {formatCurrency(calculation.perPersonTravel)}</span>
                      </div>
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
                      <th className="px-4 py-3 whitespace-nowrap">提交時間</th>
                      <th className="px-4 py-3 whitespace-nowrap">出差日期</th>
                      <th className="px-4 py-3 whitespace-nowrap">出差人員</th>
                      <th className="px-4 py-3 whitespace-nowrap">地點</th>
                      <th className="px-4 py-3 text-right whitespace-nowrap">總金額</th>
                      <th className="px-4 py-3 text-center whitespace-nowrap">身份</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myHistory.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                          尚無申請資料
                        </td>
                      </tr>
                    ) : (
                      myHistory.map((item) => {
                        const isSubmitter = item.submitterId === currentUser.id;
                        return (
                          <tr key={item.id} className="bg-white border-b hover:bg-slate-50">
                            <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                              {formatTimestamp(item.timestamp)}
                            </td>
                            <td className="px-4 py-3 font-medium text-slate-900 whitespace-nowrap">{item.date}</td>
                            <td className="px-4 py-3">
                              <div className="font-medium text-slate-800">
                                {item.applicants?.join(', ') || 'N/A'}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="font-medium">
                                {item.destinations
                                  ? item.destinations.map((d: any) => d.address).join(' → ')
                                  : item.destination}
                              </div>
                              <div className="text-xs text-slate-400">{item.reason}</div>
                            </td>
                            <td className="px-4 py-3 text-right font-bold text-blue-600 font-mono">
                              {formatCurrency(item.grandTotal)}
                            </td>
                            <td className="px-4 py-3 text-center">
                              {isSubmitter ? (
                                <span className="inline-block px-2 py-1 text-xs font-semibold text-green-700 bg-green-100 rounded-full">
                                  我提交的
                                </span>
                              ) : (
                                <span className="inline-block px-2 py-1 text-xs font-semibold text-blue-700 bg-blue-100 rounded-full">
                                  參與出差
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })
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
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                <div>
                  <h2 className="text-xl font-bold text-slate-800">出差津貼彙總表</h2>
                  <p className="text-sm text-slate-500">供管理部 (小井) 月結使用</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-slate-400" />
                    <input
                      type="month"
                      value={exportMonth}
                      onChange={e => setExportMonth(e.target.value)}
                      className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <button
                    onClick={downloadMonthlyCSV}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium"
                  >
                    <Download className="w-4 h-4" />
                    下載月報 CSV
                  </button>
                </div>
              </div>
              <div className="flex justify-end mb-4">
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
                      <th className="px-4 py-3 whitespace-nowrap">提交時間</th>
                      <th className="px-4 py-3 whitespace-nowrap">提交人</th>
                      <th className="px-4 py-3 whitespace-nowrap">出差日期</th>
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
                        <td colSpan={10} className="px-4 py-8 text-center text-slate-400">
                          目前尚無申請資料
                        </td>
                      </tr>
                    ) : (
                      history.map((item) => (
                        <tr key={item.id} className="bg-white border-b hover:bg-slate-50">
                          <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                            {formatTimestamp(item.timestamp)}
                          </td>
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
                            <div className="font-medium">
                              {item.destinations
                                ? item.destinations.map((d: any) => d.address).join(' → ')
                                : item.destination}
                            </div>
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