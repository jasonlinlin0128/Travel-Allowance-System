import { useState, useEffect, useMemo, Fragment } from 'react';
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
  Calendar,
  ChevronRight
} from 'lucide-react';

// Removed direct import of @google/generative-ai to avoid bundling issues on Vercel.

import * as XLSX from 'xlsx';

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
  serverTimestamp,
  deleteDoc,
  doc,
  updateDoc
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

// 一天疲勞津貼（每人）：早出 ≤05:00 +200/0.5h；晚歸 >21:00 +200/0.5h
const calcDayFatigueAmount = (startTime: string, endTime: string): number => {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const startDec = sh + sm / 60;
  const endDec = eh + em / 60;
  let f = 0;
  if (startDec <= 5) f += Math.floor((8 - startDec) * 2) / 2 * 200;
  if (endDec > 21) f += Math.floor((endDec - 21) * 2) / 2 * 200;
  return f;
};

// 重複登打偵測：找出 history 中與 candidate 有「申請人重疊 + 日期區間 overlap」的紀錄
// 用於：(a) 提交時擋（excludeId = editingRecordId），(c) 後台逐筆掃自己 vs 其他
export interface DuplicateMatch {
  record: TravelRequestLike;
  overlappingApplicants: string[];
  overlapStart: string; // YYYY-MM-DD
  overlapEnd: string;   // YYYY-MM-DD
}
type TravelRequestLike = {
  id?: string;
  submitterId?: string;
  submitterName?: string;
  applicants?: string[];
  date?: string;
  nights?: number;
  destinations?: { address: string; oneWayHours?: number; dayIndex?: number }[];
  destination?: string;
  reason?: string;
  [k: string]: any;
};
const findDuplicateRecords = (
  candidate: { applicants: string[]; date: string; nights: number },
  history: TravelRequestLike[],
  excludeId?: string | null,
): DuplicateMatch[] => {
  if (!candidate.applicants || candidate.applicants.length === 0) return [];
  if (!candidate.date) return [];

  const candStart = candidate.date;
  const candEnd = addDays(candidate.date, candidate.nights || 0);
  const candApplicants = new Set(
    candidate.applicants.map(a => a.trim()).filter(Boolean)
  );
  if (candApplicants.size === 0) return [];

  const matches: DuplicateMatch[] = [];
  for (const rec of history) {
    if (excludeId && rec.id === excludeId) continue;       // 編輯豁免
    if (!rec.date || !rec.applicants || rec.applicants.length === 0) continue;

    // 申請人重疊
    const overlapping = rec.applicants
      .map(a => a.trim())
      .filter(a => a && candApplicants.has(a));
    if (overlapping.length === 0) continue;

    // 日期區間 overlap：[a1,a2] 與 [b1,b2] 相交 ⇔ a1 ≤ b2 且 b1 ≤ a2
    const recStart = rec.date;
    const recEnd = addDays(rec.date, rec.nights || 0);
    if (candStart > recEnd || recStart > candEnd) continue;

    matches.push({
      record: rec,
      overlappingApplicants: overlapping,
      overlapStart: candStart > recStart ? candStart : recStart,
      overlapEnd: candEnd < recEnd ? candEnd : recEnd,
    });
  }
  return matches;
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
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // AI State
  const [isEstimating, setIsEstimating] = useState(false);

  // Export State
  const [exportMonth, setExportMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  // Personal History Filter
  const [myFilterMode, setMyFilterMode] = useState<'all' | 'year' | 'month' | 'day'>('all');
  const [myFilterValue, setMyFilterValue] = useState('');
  const [myFilterKeyword, setMyFilterKeyword] = useState('');

  // Admin Filter
  const [adminFilterMode, setAdminFilterMode] = useState<'all' | 'year' | 'month' | 'day'>('all');
  const [adminFilterValue, setAdminFilterValue] = useState('');
  const [adminFilterKeyword, setAdminFilterKeyword] = useState('');

  // Admin: 哪幾筆紀錄目前展開明細（多筆可同時展開以利比對）
  const [expandedAdminRows, setExpandedAdminRows] = useState<Set<string>>(new Set());
  const toggleAdminRow = (id: string) => {
    setExpandedAdminRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 重複登打偵測 modal 狀態
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateMatch[] | null>(null);
  const [duplicateConfirmCheck, setDuplicateConfirmCheck] = useState(false);

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
    destinations: [{ address: '', oneWayHours: 0, dayIndex: 0 }],
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
      // 成功讀回就清掉之前的錯誤訊息
      setAuthError(null);
    }, (error: any) => {
      console.error("Firestore Error:", error);
      // 失敗時顯示給使用者（取代之前只 console，畫面一片空白沒提示）
      const code = error?.code || '';
      const msg = code === 'permission-denied'
        ? '無權限讀取資料庫，請聯絡系統管理員確認 Firestore 規則。'
        : code === 'unavailable'
        ? '資料庫暫時無法連線，請檢查網路後再試。'
        : `資料庫讀取失敗：${error?.message || code || '未知錯誤'}`;
      setAuthError(msg);
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
    setFormData(prev => ({ ...prev, applicants: [''], destinations: [{ address: '', oneWayHours: 0, dayIndex: 0 }], effectiveOneWayHours: 0 }));
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

    // 2. Travel Allowance (Car)
    // Multi-day: sum each day's legs (destinations filtered by dayIndex), or manual drivingHours override
    // Single-day: effectiveOneWayHours x2 (round trip)
    const oneWayHours = formData.effectiveOneWayHours;
    const units = Math.floor(oneWayHours / 1.5);
    const singleTripAllowance = units * 30;
    if (formData.nights > 0 && formData.dayEntries.length > 0) {
      carTotalAllowance = formData.dayEntries.reduce((sum, entry, dayIdx) => {
        // If user has manually set drivingHours, use it; otherwise sum all legs for this day
        let dayHours: number;
        if (entry.drivingHours !== undefined && entry.drivingHours > 0) {
          dayHours = entry.drivingHours;
        } else {
          const dayDests = formData.destinations.filter(d => (d.dayIndex ?? 0) === dayIdx);
          dayHours = dayDests.reduce((h, d) => h + (d.oneWayHours || 0), 0);
        }
        return sum + Math.floor(dayHours / 1.5) * 30;
      }, 0);
    } else {
      carTotalAllowance = singleTripAllowance * 2;
    }

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

  }, [formData.startTime, formData.endTime, formData.effectiveOneWayHours, formData.applicants.length, formData.nights, formData.dayEntries, formData.destinations]);

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

  const handleDayEntryChange = (index: number, field: 'startTime' | 'endTime' | 'drivingHours' | 'startingPoint', value: string | number) => {
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
          const prevDayDests = prev.destinations.filter(d => (d.dayIndex ?? 0) === i - 1);
          const autoStartingPoint = i === 0
            ? DEFAULT_ORIGIN
            : prevDayDests.length > 0 ? prevDayDests[prevDayDests.length - 1].address : DEFAULT_ORIGIN;
          return {
            date: addDays(prev.date, i),
            startTime: i === 0 ? prev.startTime : '08:00',
            endTime: i === totalDays - 1 ? prev.endTime : '17:00',
            startingPoint: autoStartingPoint,
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
      const maxHours = newDests.reduce((s, d) => s + (d.oneWayHours || 0), 0);
      let newEntries = prev.dayEntries;
      if (prev.nights > 0 && (field === 'dayIndex' || field === 'address')) {
        newEntries = prev.dayEntries.map((entry, i) => {
          if (i === 0) return entry;
          const oldPrevDests = prev.destinations.filter(d => (d.dayIndex ?? 0) === i - 1);
          const oldAutoSP = oldPrevDests.length > 0 ? oldPrevDests[oldPrevDests.length - 1].address : DEFAULT_ORIGIN;
          const newPrevDests = newDests.filter(d => (d.dayIndex ?? 0) === i - 1);
          const newAutoSP = newPrevDests.length > 0 ? newPrevDests[newPrevDests.length - 1].address : DEFAULT_ORIGIN;
          if (!entry.startingPoint || entry.startingPoint === oldAutoSP) {
            return { ...entry, startingPoint: newAutoSP };
          }
          return entry;
        });
      }
      return { ...prev, destinations: newDests, effectiveOneWayHours: maxHours, dayEntries: newEntries };
    });
  };

  const addDestination = () => {
    setFormData(prev => ({
      ...prev,
      destinations: [...prev.destinations, { address: '', oneWayHours: 0, dayIndex: 0 }],
    }));
    setFocusedDestinationIndex(formData.destinations.length);
  };

  const removeDestination = (index: number) => {
    if (formData.destinations.length <= 1) return;
    setFormData(prev => {
      const newDests = prev.destinations.filter((_, i) => i !== index);
      const maxHours = newDests.reduce((s, d) => s + (d.oneWayHours || 0), 0);
      return { ...prev, destinations: newDests, effectiveOneWayHours: maxHours };
    });
    setFocusedDestinationIndex(0);
  };

  const handleLocationSelect = (e: React.ChangeEvent<HTMLSelectElement>, destIndex: number) => {
    const selectedName = e.target.value;
    if (!selectedName || selectedName === 'custom') {
      e.currentTarget.value = ''; // reset
      return;
    }
    const location = PREDEFINED_LOCATIONS.find(loc => loc.name === selectedName);
    if (location) {
      setFormData(prev => {
        const newDests = [...prev.destinations];
        const existing = newDests[destIndex];
        newDests[destIndex] = {
          ...existing,
          address: location.name,
          // For dest 0: use constant hours (company→place)
          // For dest > 0: will be overwritten by AI estimate below
          oneWayHours: destIndex === 0 ? location.hours : (existing.oneWayHours || 0),
        };
        const maxHours = newDests.reduce((s, d) => s + (d.oneWayHours || 0), 0);
        return { ...prev, destinations: newDests, effectiveOneWayHours: maxHours };
      });
      // For dest > 0: auto-trigger AI to calculate leg time from previous destination
      if (destIndex > 0) {
        // Pass the selected name directly so we don't need to wait for state update
        setTimeout(() => handleAIEstimate(destIndex, location.name), 50);
      }
    }
    e.currentTarget.value = ''; // reset so placeholder shows again
  };

  // --- AI Estimation Logic ---
  const handleAIEstimate = async (overrideIndex?: number, userInputOverride?: string) => {
    const idx = overrideIndex ?? focusedDestinationIndex;
    const dest = formData.destinations[idx];
    const userInput = userInputOverride || dest?.address;
    if (!userInput || userInput.trim() === '') {
      alert("請先輸入大概的地點名稱（例如：台積電南科）");
      return;
    }

    setIsEstimating(true);

    // Compute the 'from' address: previous leg endpoint or starting point of that day
    const aiDayIdx = formData.destinations[idx]?.dayIndex ?? 0;
    const sameDayDestsUpToHere = formData.destinations
      .map((d, i) => ({ ...d, origIdx: i }))
      .filter(d => (d.dayIndex ?? 0) === aiDayIdx && d.origIdx < idx);
    let fromAddress: string;
    if (sameDayDestsUpToHere.length > 0) {
      fromAddress = sameDayDestsUpToHere[sameDayDestsUpToHere.length - 1].address || DEFAULT_ORIGIN;
    } else if (aiDayIdx === 0) {
      fromAddress = DEFAULT_ORIGIN;
    } else {
      const prevDayDests = formData.destinations.filter(d => (d.dayIndex ?? 0) === aiDayIdx - 1);
      fromAddress = prevDayDests.length > 0 ? prevDayDests[prevDayDests.length - 1].address : DEFAULT_ORIGIN;
    }

    console.log(`[AI] dest[${idx}] "${userInput}", from: "${fromAddress}", dayIdx: ${aiDayIdx}, sameDayBefore: ${sameDayDestsUpToHere.length}`);

    try {
      const resp = await fetch('/api/ai-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: userInput, origin: fromAddress })
      });


      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(txt || 'AI estimate failed');
      }

      const result = await resp.json();
      setFormData(prev => {
        const newDests = [...prev.destinations];
        newDests[idx] = {
          ...newDests[idx],                              // ← preserve dayIndex and other fields
          address: result.fullAddress || dest.address,
          oneWayHours: result.hours || dest.oneWayHours
        };
        const maxHours = newDests.reduce((s, d) => s + (d.oneWayHours || 0), 0);
        return { ...prev, destinations: newDests, effectiveOneWayHours: maxHours };
      });

    } catch (error) {
      console.error("AI Estimate Error:", error);
      alert("AI 估算失敗，請稍後再試或手動輸入。\n(確保已在 Vercel 設定 GOOGLE_MAPS_API_KEY)");
    } finally {
      setIsEstimating(false);
    }
  };

  // --- Edit Record ---
  const handleEditRecord = (record: TravelRequest) => {
    setFormData({
      applicants: record.applicants || [currentUser!.name],
      reason: record.reason || '',
      date: record.date || new Date().toISOString().split('T')[0],
      // legacy 紀錄沒 destinations 陣列：用 destination 字串建單一目的地，補 dayIndex=0 與多日邏輯一致
      destinations: record.destinations
        ? record.destinations.map(d => ({ ...d, dayIndex: d.dayIndex ?? 0 }))
        : [{ address: record.destination || '', oneWayHours: record.oneWayHours || record.effectiveOneWayHours || 0, dayIndex: 0 }],
      effectiveOneWayHours: record.effectiveOneWayHours || record.oneWayHours || 0,
      startTime: record.startTime || '08:00',
      endTime: record.endTime || '17:00',
      nights: record.nights || 0,
      dayEntries: record.dayEntries || [],
    });
    setEditingRecordId(record.id!);
    setActiveTab('form');
    window.scrollTo(0, 0);
  };
  // Form 提交入口：驗證 + 偵測重複，無重複才直接 performSubmit；有重複先彈 modal
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser && !isDemoMode) return;
    if (!currentUser) return; // Should not happen if UI is correct

    if (formData.applicants.some(name => !name.trim())) {
      alert("請填寫所有出差人員姓名");
      return;
    }

    // 重複登打偵測：申請人重疊 + 日期區間 overlap（編輯時自動排除自己）
    const trimmedApplicants = formData.applicants.map(a => a.trim()).filter(Boolean);
    const matches = findDuplicateRecords(
      { applicants: trimmedApplicants, date: formData.date, nights: formData.nights || 0 },
      history,
      editingRecordId,
    );
    if (matches.length > 0) {
      setDuplicateWarning(matches);
      setDuplicateConfirmCheck(false);
      return; // 等使用者在 modal 確認再 performSubmit
    }

    void performSubmit();
  };

  // 真正寫入 Firestore / localStorage 的程序，可從 handleSubmit 或 modal 確認鈕呼叫
  const performSubmit = async () => {
    if (!currentUser) return;
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
        dayEntries: formData.nights > 0 ? formData.dayEntries : null,

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
        // LocalStorage Save (含編輯路徑)
        if (editingRecordId) {
          // UPDATE existing local record（之前 demo mode 的編輯會跑成新增=重複，這裡修正）
          const updatedHistory = history.map(rec =>
            rec.id === editingRecordId ? { ...payload, id: editingRecordId } : rec
          );
          setHistory(updatedHistory);
          localStorage.setItem('travel_allowance_demo_data', JSON.stringify(updatedHistory));
        } else {
          // ADD new
          const newDoc = { ...payload, id: 'local-' + Date.now() };
          const updatedHistory = [newDoc, ...history];
          setHistory(updatedHistory);
          localStorage.setItem('travel_allowance_demo_data', JSON.stringify(updatedHistory));
        }
        await new Promise(resolve => setTimeout(resolve, 600));
      } else {
        // Firebase Save
        // Remove any undefined values - Firestore rejects them
        const removeUndefined = (o: any): any => {
          if (Array.isArray(o)) return o.map(removeUndefined);
          if (o !== null && typeof o === 'object') {
            const result: any = {};
            for (const [k, v] of Object.entries(o)) {
              if (v !== undefined) result[k] = removeUndefined(v);
            }
            return result;
          }
          return o;
        };
        // Re-attach serverTimestamp() AFTER removeUndefined, because FieldValue objects
        // cannot survive recursive object traversal (their internal state gets stripped)
        const cleanPayload = removeUndefined(payload);
        cleanPayload.timestamp = serverTimestamp();
        if (editingRecordId) {
          // UPDATE existing record
          await updateDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'travel_allowances', editingRecordId), cleanPayload);
        } else {
          // ADD new record
          await addDoc(collection(db, 'artifacts', APP_ID, 'public', 'data', 'travel_allowances'), cleanPayload);
        }
      }
      // 編輯狀態統一在 try 結束前清掉（不論 demo / production）
      // 避免後續再送出時誤判為仍在編輯
      if (editingRecordId) {
        setEditingRecordId(null);
      }
      
      setFormData(prev => ({
        ...prev,
        applicants: [currentUser.name],
        reason: '',
        destinations: [{ address: '', oneWayHours: 0, dayIndex: 0 }],
        effectiveOneWayHours: 0,
        startTime: '08:00',
        endTime: '17:00',
        nights: 0,
        dayEntries: [],
      }));

      // 清掉重複警告 modal 的狀態（即便 modal 不在開啟中也安全清）
      setDuplicateWarning(null);
      setDuplicateConfirmCheck(false);

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

  // 取出整筆紀錄的「實際出發」與「實際結束」時間（含日期，方案 B 格式）
  // 多日：dayEntries[0] / dayEntries[last]；單日：record.startTime / endTime
  const getTripTimes = (item: TravelRequest): { start: string; end: string } => {
    const ymdToShort = (ymd: string) => ymd.slice(5).replace('-', '/'); // "2026-04-13" → "04/13"
    if (item.nights && item.nights > 0 && item.dayEntries && item.dayEntries.length > 0) {
      const first = item.dayEntries[0];
      const last = item.dayEntries[item.dayEntries.length - 1];
      const lastDate = addDays(item.date, item.nights);
      return {
        start: `${ymdToShort(item.date)} ${first?.startTime || '--:--'}`,
        end: `${ymdToShort(lastDate)} ${last?.endTime || '--:--'}`,
      };
    }
    return {
      start: `${ymdToShort(item.date)} ${item.startTime || '--:--'}`,
      end: `${ymdToShort(item.date)} ${item.endTime || '--:--'}`,
    };
  };

  const applyRecordFilter = (
    records: TravelRequest[],
    mode: 'all' | 'year' | 'month' | 'day',
    value: string,
    keyword: string
  ): TravelRequest[] => {
    let filtered = records;
    if (mode !== 'all' && value.trim()) {
      filtered = filtered.filter(item => {
        if (!item.date) return false;
        if (mode === 'year') return item.date.startsWith(value.trim());
        if (mode === 'month') return item.date.startsWith(value.trim());
        if (mode === 'day') return item.date === value.trim();
        return true;
      });
    }
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      filtered = filtered.filter(item => {
        if (item.date?.toLowerCase().includes(kw)) return true;
        if (item.applicants?.some(name => name.toLowerCase().includes(kw))) return true;
        const destStr = item.destinations
          ? item.destinations.map((d: any) => d.address).join(' ')
          : (item.destination || '');
        if (destStr.toLowerCase().includes(kw)) return true;
        if (item.reason?.toLowerCase().includes(kw)) return true;
        return false;
      });
    }
    return filtered;
  };

  // --- Download Monthly Excel ---
  const downloadMonthlyExcel = () => {
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

    // ===== Per-day allowance expansion =====
    // 多日出差紀錄按 dayEntries 攤到對應日期；單日紀錄整批費用在 record.date
    // 過夜津貼方案 X：「當晚住=當天計」→ 第 0..nights-1 天各 $300，最後一天回程 0
    // 跨月份方案 X：4/29-5/2 紀錄整筆歸 4 月匯出，但 5/1、5/2 仍以實際日期顯示
    // 高鐵情境：destinations 不填或 0h → 車程自動 0，疲勞/過夜照 dayEntries / nights 計
    const expandRecordPerDay = (record: TravelRequest): { date: string; fatigue: number; travel: number; overnight: number }[] => {
      const headcount = record.passengers || record.applicants?.length || 1;

      // 單日紀錄（沒過夜）：整批費用就在 record.date 那天
      if (!record.nights || record.nights === 0 || !record.dayEntries || record.dayEntries.length === 0) {
        return [{
          date: record.date,
          fatigue: record.perPersonFatigue ?? (record.fatigueAllowanceTotal / headcount),
          travel: record.perPersonTravel ?? (record.travelAllowanceTotal / headcount),
          overnight: 0,
        }];
      }

      // 多日紀錄：逐天展開
      const result: { date: string; fatigue: number; travel: number; overnight: number }[] = [];
      for (let i = 0; i <= record.nights; i++) {
        const dateKey = addDays(record.date, i);
        const entry = record.dayEntries[i];

        let fatigue = 0;
        let travel = 0;

        if (entry) {
          // 該日疲勞津貼：每天 startTime/endTime 各自算
          fatigue = calcDayFatigueAmount(entry.startTime, entry.endTime);

          // 該日車程津貼：drivingHours 手動覆蓋優先，否則加總當天 destinations
          let dayHours: number;
          if (entry.drivingHours !== undefined && entry.drivingHours > 0) {
            dayHours = entry.drivingHours;
          } else {
            const dayDests = (record.destinations || []).filter(d => (d.dayIndex ?? 0) === i);
            dayHours = dayDests.reduce((h, d) => h + (d.oneWayHours || 0), 0);
          }
          travel = Math.floor(dayHours / 1.5) * 30;
        }

        // 過夜津貼（方案 X：當晚住=當天計）
        const overnight = i < record.nights ? 300 : 0;

        result.push({ date: dateKey, fatigue, travel, overnight });
      }
      return result;
    };

    // Build per-employee-per-date data with per-day expansion
    const dateMap: Record<string, Record<string, { fatigue: number; travel: number; overnight: number }>> = {};
    const employeeSet = new Set<string>();

    for (const record of monthRecords) {
      const applicants = record.applicants || [];
      const dailyEntries = expandRecordPerDay(record);

      for (const day of dailyEntries) {
        if (!dateMap[day.date]) dateMap[day.date] = {};
        for (const name of applicants) {
          employeeSet.add(name);
          if (!dateMap[day.date][name]) {
            dateMap[day.date][name] = { fatigue: 0, travel: 0, overnight: 0 };
          }
          dateMap[day.date][name].fatigue += day.fatigue;
          dateMap[day.date][name].travel += day.travel;
          dateMap[day.date][name].overnight += day.overnight;
        }
      }
    }

    const employees = Array.from(employeeSet).sort();
    const dates = Object.keys(dateMap).sort();

    // ====== Sheet 1: 總表 ======
    // 版面：每個員工佔 4 欄（疲勞/車程/過夜/個人小計）；員工名橫跨 4 欄合併儲存格
    // 第一欄「日期」、最後欄「當日合計」皆縱向合併兩列
    // 有紀錄的格子一律顯示數字（包含 0），完全沒紀錄的日期/員工才留空
    const summaryRows: (string | number)[][] = [];
    const COLS_PER_EMP = 4; // 疲勞 + 車程 + 過夜 + 小計

    // Row 1: 員工名 header（合併儲存格用，員工名放第一格，其餘 3 格空白）
    const header1: (string | number)[] = ['日期'];
    for (const emp of employees) {
      header1.push(emp, '', '', '');
    }
    header1.push('當日合計');
    summaryRows.push(header1);

    // Row 2: 子欄位 header
    const header2: (string | number)[] = [''];
    for (let i = 0; i < employees.length; i++) {
      header2.push('出差津貼', '車程加給', '跨日津貼', '小計');
    }
    header2.push('');
    summaryRows.push(header2);

    // Employee totals accumulator
    const empTotals: Record<string, { fatigue: number; travel: number; overnight: number }> = {};
    for (const emp of employees) {
      empTotals[emp] = { fatigue: 0, travel: 0, overnight: 0 };
    }
    let grandTotal = 0;

    // Data rows（每人 4 欄含個人當日小計）
    for (const dateKey of dates) {
      const [, m, d] = dateKey.split('-').map(Number);
      const dateLabel = `${m}/${d}`;
      const row: (string | number)[] = [dateLabel];
      let dayTotal = 0;

      for (const emp of employees) {
        const data = dateMap[dateKey][emp];
        if (data) {
          const personDay = data.fatigue + data.travel + data.overnight;
          // 有紀錄就一律顯示（包含 0），讓中間天的 0 看得到
          row.push(
            Math.round(data.fatigue),
            Math.round(data.travel),
            Math.round(data.overnight),
            Math.round(personDay)
          );
          dayTotal += personDay;
          empTotals[emp].fatigue += data.fatigue;
          empTotals[emp].travel += data.travel;
          empTotals[emp].overnight += data.overnight;
        } else {
          row.push('', '', '', '');
        }
      }
      row.push(dayTotal ? Math.round(dayTotal) : '');
      grandTotal += dayTotal;
      summaryRows.push(row);
    }

    // 合計 row：每人 3 項分開合計 + 個人月度小計
    const totalRow: (string | number)[] = ['合計'];
    for (const emp of employees) {
      const t = empTotals[emp];
      const empMonthTotal = t.fatigue + t.travel + t.overnight;
      totalRow.push(
        t.fatigue ? Math.round(t.fatigue) : '',
        t.travel ? Math.round(t.travel) : '',
        t.overnight ? Math.round(t.overnight) : '',
        empMonthTotal ? Math.round(empMonthTotal) : ''
      );
    }
    totalRow.push(Math.round(grandTotal));
    summaryRows.push(totalRow);

    // Empty row + Grand total
    summaryRows.push([]);
    const grandRow: (string | number)[] = new Array(header1.length).fill('');
    grandRow[0] = '總計';
    grandRow[header1.length - 1] = Math.round(grandTotal);
    summaryRows.push(grandRow);

    // Create workbook
    const wb = XLSX.utils.book_new();

    // Add summary sheet
    const summaryWs = XLSX.utils.aoa_to_sheet(summaryRows);

    // ===== 合併儲存格 =====
    // 1. 第一欄「日期」縱向跨兩列 (row 0-1, col 0)
    // 2. 每個員工名橫向跨 4 欄 (row 0)
    // 3. 最後欄「當日合計」縱向跨兩列 (row 0-1, last col)
    const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
    const lastCol = header1.length - 1;
    merges.push({ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } });
    merges.push({ s: { r: 0, c: lastCol }, e: { r: 1, c: lastCol } });
    for (let e = 0; e < employees.length; e++) {
      const startCol = 1 + e * COLS_PER_EMP;
      const endCol = startCol + COLS_PER_EMP - 1;
      merges.push({ s: { r: 0, c: startCol }, e: { r: 0, c: endCol } });
    }
    summaryWs['!merges'] = merges;

    // ===== 欄寬 =====
    const cols: { wch: number }[] = [{ wch: 8 }]; // 日期
    for (let i = 0; i < employees.length; i++) {
      cols.push({ wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 });
    }
    cols.push({ wch: 10 }); // 當日合計
    summaryWs['!cols'] = cols;

    XLSX.utils.book_append_sheet(wb, summaryWs, '總表');

    // ====== Per-employee sheets ======
    // Find employee ID from EMPLOYEES constant
    const findEmpId = (name: string): string => {
      const emp = EMPLOYEES.find(e => e.name === name);
      return emp ? emp.id : '';
    };

    // Get all dates in the month for complete date column
    const daysInMonth = new Date(year, month, 0).getDate();
    const allDates: string[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      allDates.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    // 跨月紀錄展開出的次月日期（例如 4/29-5/2 紀錄在 4 月匯出會多 5/1、5/2 列）
    for (const dateKey of Object.keys(dateMap)) {
      if (!allDates.includes(dateKey)) {
        allDates.push(dateKey);
      }
    }
    allDates.sort();

    for (const empName of employees) {
      const empId = findEmpId(empName);
      const sheetRows: (string | number)[][] = [];

      // Header row: employee code (name) | 出差津貼 | 車程加給 | 跨日津貼 | 小計
      sheetRows.push([`${empId}(${empName})`, '出差津貼', '車程加給', '跨日津貼', '小計']);

      let empFatigueTotal = 0;
      let empTravelTotal = 0;
      let empOvernightTotal = 0;

      // One row per day（含跨月攤出來的次月日）
      for (const dateKey of allDates) {
        const [, m, d] = dateKey.split('-').map(Number);
        const dateLabel = `${m}/${d}`;
        const data = dateMap[dateKey]?.[empName];

        if (data) {
          const f = Math.round(data.fatigue);
          const t = Math.round(data.travel);
          const o = Math.round(data.overnight);
          const sub = f + t + o;
          // 有紀錄就一律顯示（包含 0），讓中間天的 0 看得到
          sheetRows.push([dateLabel, f, t, o, sub]);
          empFatigueTotal += data.fatigue;
          empTravelTotal += data.travel;
          empOvernightTotal += data.overnight;
        } else {
          sheetRows.push([dateLabel, '', '', '', '']);
        }
      }

      // Totals row（最後加個人月度小計）
      const empGrand = empFatigueTotal + empTravelTotal + empOvernightTotal;
      sheetRows.push([
        '合計',
        empFatigueTotal ? Math.round(empFatigueTotal) : '',
        empTravelTotal ? Math.round(empTravelTotal) : '',
        empOvernightTotal ? Math.round(empOvernightTotal) : '',
        empGrand ? Math.round(empGrand) : ''
      ]);

      const empWs = XLSX.utils.aoa_to_sheet(sheetRows);
      // Set column widths for readability
      empWs['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, empWs, empName);
    }

    // Download
    XLSX.writeFile(wb, `出差津貼總表_${year}年${month}月.xlsx`);
  };

  // --- Delete Record ---
  const handleDeleteRecord = async (record: TravelRequest) => {
    const label = `${record.date} - ${record.submitterName || '未知'} - ${record.applicants?.join(', ') || 'N/A'}`;
    if (!window.confirm(`確定要刪除這筆紀錄嗎？\n\n${label}\n總計：${formatCurrency(record.grandTotal)}`)) {
      return;
    }

    try {
      if (isDemoMode) {
        const updated = history.filter(item => item.id !== record.id);
        setHistory(updated);
        localStorage.setItem('travel_allowance_demo_data', JSON.stringify(updated));
      } else {
        await deleteDoc(doc(db, 'artifacts', APP_ID, 'public', 'data', 'travel_allowances', record.id));
        // Firestore onSnapshot will automatically update the history state
      }
    } catch (error) {
      console.error('刪除失敗:', error);
      alert('刪除失敗，請稍後再試');
    }
  };

  // 後台稽核：每筆紀錄找其他疑似重複的（自己 vs 全部，排除自己）
  // 用 record.id 當 key；如果有 match → 該 row 標 ⚠️ 疑似重複 pill
  // 注意：useMemo 必須在所有 early return 之前呼叫，避免 hooks order 違規造成 React crash
  const adminDuplicateMap = useMemo(() => {
    const map: Record<string, DuplicateMatch[]> = {};
    for (const rec of history) {
      if (!rec.id || !rec.applicants || !rec.date) continue;
      const matches = findDuplicateRecords(
        { applicants: rec.applicants, date: rec.date, nights: rec.nights || 0 },
        history,
        rec.id,
      );
      if (matches.length > 0) map[rec.id] = matches;
    }
    return map;
  }, [history]);

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

  const filteredMyHistory = applyRecordFilter(myHistory, myFilterMode, myFilterValue, myFilterKeyword);
  const filteredAdminHistory = applyRecordFilter(history, adminFilterMode, adminFilterValue, adminFilterKeyword);

  // 取得星期幾單字（用於 Excel 與展開明細）
  const getWeekday = (ymd: string): string => {
    const [yy, mm, dd] = ymd.split('-').map(Number);
    const dt = new Date(yy, mm - 1, dd);
    return ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()];
  };

  // 後台展開明細卡片：總務點 chevron 後顯示完整出差資訊以利覆核
  const AdminRecordDetail = ({ item, dupMatches }: { item: TravelRequest; dupMatches?: DuplicateMatch[] }) => {
    const isMultiDay = !!(item.nights && item.nights > 0 && item.dayEntries && item.dayEntries.length > 0);
    const headcount = item.passengers || item.applicants?.length || 1;

    return (
      <div className="space-y-5">
        {/* 疑似重複警示 */}
        {dupMatches && dupMatches.length > 0 && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-3">
            <div className="flex items-start gap-2 mb-2">
              <AlertCircle className="w-4 h-4 text-rose-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm font-semibold text-rose-700">
                偵測到 {dupMatches.length} 筆紀錄與此筆有日期 + 申請人重疊（可能重複登打）
              </div>
            </div>
            <ul className="space-y-1.5 text-xs">
              {dupMatches.map((m, i) => (
                <li key={i} className="bg-white rounded border border-rose-100 px-2 py-1.5">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-mono text-slate-700">
                      {m.record.date}
                      {(m.record.nights || 0) > 0 && <> ~ {addDays(m.record.date!, m.record.nights || 0)}</>}
                    </span>
                    <span className="text-slate-400 text-[11px]">
                      提交人：{m.record.submitterName}（{m.record.submitterId}）
                    </span>
                  </div>
                  <div className="text-slate-600">
                    申請人：
                    {m.record.applicants?.map((a, j) => (
                      <span
                        key={j}
                        className={
                          m.overlappingApplicants.includes(a)
                            ? 'font-semibold text-rose-700 bg-rose-100 px-1 rounded mr-1'
                            : 'text-slate-500 mr-1'
                        }
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                  <div className="text-rose-600 mt-0.5">
                    重疊：{m.overlappingApplicants.join('、')} 在 <span className="font-mono">{m.overlapStart}</span>
                    {m.overlapStart !== m.overlapEnd && <> ~ <span className="font-mono">{m.overlapEnd}</span></>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 基本資訊：3 張 icon 卡 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-white rounded-lg border border-blue-100 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-1.5 text-xs text-blue-700 font-medium mb-1.5">
              <Calendar className="w-3.5 h-3.5" />
              出差期間
            </div>
            <div className="font-medium text-slate-800 text-sm">
              <span className="font-mono">{item.date}</span>
              {isMultiDay && (
                <>
                  <span className="text-slate-400 mx-1">~</span>
                  <span className="font-mono">{addDays(item.date, item.nights!)}</span>
                  <span className="ml-2 inline-block px-2 py-0.5 text-[11px] font-semibold text-blue-700 bg-blue-100 rounded-full">
                    {item.nights! + 1}天{item.nights}夜
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg border border-blue-100 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-1.5 text-xs text-blue-700 font-medium mb-1.5">
              <UserCircle className="w-3.5 h-3.5" />
              提交人 / 出差人員
            </div>
            <div className="text-sm">
              <div className="font-medium text-slate-800">
                {item.submitterName || '未知'}
                <span className="text-slate-400 text-xs ml-1">({item.submitterId})</span>
              </div>
              <div className="text-xs text-slate-600 mt-0.5">
                申請人：{item.applicants?.join('、') || 'N/A'}
                <span className="ml-1 text-slate-400">共 {headcount} 人</span>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-blue-100 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-1.5 text-xs text-blue-700 font-medium mb-1.5">
              <FileText className="w-3.5 h-3.5" />
              申請事由
            </div>
            <div className="text-sm font-medium text-slate-800 break-words">
              {item.reason || <span className="text-slate-400 italic">(未填)</span>}
            </div>
          </div>
        </div>

        {/* 多日逐日明細表 */}
        {isMultiDay ? (
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
            <div className="flex items-center gap-1.5 px-4 py-2.5 bg-gradient-to-r from-slate-50 to-blue-50 border-b border-slate-200">
              <Clock className="w-4 h-4 text-slate-600" />
              <span className="text-sm font-semibold text-slate-700">逐日明細</span>
              <span className="text-xs text-slate-400">（總務可逐日覆核）</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">天數</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">日期</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">起點</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">出發</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">結束</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap font-medium">行駛時數</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">當天目的地</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap font-medium border-l border-slate-200 bg-amber-50/40">疲勞</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap font-medium bg-sky-50/40">車程</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap font-medium bg-violet-50/40">過夜</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap font-bold text-blue-700 bg-blue-50/60">當日合計</th>
                  </tr>
                </thead>
                <tbody>
                  {item.dayEntries!.map((entry, i) => {
                    const dateStr = addDays(item.date, i);
                    const isFirst = i === 0;
                    const isLast = i === item.nights;
                    const dayLabel = isFirst ? '出發日' : isLast ? '返回日' : `第 ${i + 1} 天`;
                    const dayDests = (item.destinations || []).filter(d => (d.dayIndex ?? 0) === i);
                    const autoHours = dayDests.reduce((h, d) => h + (d.oneWayHours || 0), 0);
                    const manualHours = entry?.drivingHours;
                    const usedHours = manualHours !== undefined && manualHours > 0 ? manualHours : autoHours;
                    // 該天每人津貼 → 乘 headcount = 該天總額
                    const dayFatiguePerPerson = calcDayFatigueAmount(entry?.startTime || '', entry?.endTime || '');
                    const dayTravelPerPerson = Math.floor(usedHours / 1.5) * 30;
                    const dayOvernightPerPerson = i < item.nights! ? 300 : 0;
                    const dayFatigueTotal = dayFatiguePerPerson * headcount;
                    const dayTravelTotal = dayTravelPerPerson * headcount;
                    const dayOvernightTotal = dayOvernightPerPerson * headcount;
                    const daySubtotal = dayFatigueTotal + dayTravelTotal + dayOvernightTotal;
                    const labelClass = isFirst
                      ? 'bg-emerald-100 text-emerald-700'
                      : isLast
                      ? 'bg-rose-100 text-rose-700'
                      : 'bg-slate-100 text-slate-600';
                    return (
                      <tr key={i} className={`border-b border-slate-100 ${i % 2 === 1 ? 'bg-slate-50/40' : 'bg-white'}`}>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`inline-block px-2 py-0.5 text-[11px] font-semibold rounded-full ${labelClass}`}>
                            {dayLabel}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap text-slate-700">
                          {dateStr}
                          <span className="text-slate-400 text-[11px] ml-1">({getWeekday(dateStr)})</span>
                        </td>
                        <td className="px-3 py-2 text-slate-700">
                          {entry?.startingPoint || <span className="text-slate-400 italic">(自動帶入)</span>}
                        </td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap text-slate-700">{entry?.startTime || '--:--'}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap text-slate-700">{entry?.endTime || '--:--'}</td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                          <span className="text-slate-700 font-medium">{usedHours}h</span>
                          {manualHours !== undefined && manualHours > 0 && (
                            <span className="ml-1.5 inline-block px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 bg-amber-100 rounded">
                              手動
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {dayDests.length > 0 ? (
                            <ul className="space-y-0.5">
                              {dayDests.map((d, j) => (
                                <li key={j} className="text-slate-700">
                                  {d.address}
                                  <span className="text-slate-400 ml-1 text-[11px]">（{d.oneWayHours}h）</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <span className="text-slate-400 italic text-[11px]">(無 / 未開車)</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-slate-800 border-l border-slate-200 bg-amber-50/30">
                          {dayFatigueTotal > 0 ? formatCurrency(dayFatigueTotal) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-slate-800 bg-sky-50/30">
                          {dayTravelTotal > 0 ? formatCurrency(dayTravelTotal) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-slate-800 bg-violet-50/30">
                          {dayOvernightTotal > 0 ? formatCurrency(dayOvernightTotal) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap font-bold text-blue-700 bg-blue-50/40">
                          {daySubtotal > 0 ? formatCurrency(daySubtotal) : <span className="text-slate-300">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {/* 合計列：對照 row 既有的疲勞/車程/跨日 應該完全一致 */}
                  <tr className="border-t-2 border-blue-300 bg-blue-50 font-semibold">
                    <td className="px-3 py-2" colSpan={5}>
                      <span className="text-slate-600">總計</span>
                      <span className="ml-2 text-[11px] text-slate-400 font-normal">（對照右上方欄位金額）</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-slate-700">
                      {item.dayEntries!.reduce((sum, e, i) => {
                        const dDests = (item.destinations || []).filter(d => (d.dayIndex ?? 0) === i);
                        const aHrs = dDests.reduce((h, d) => h + (d.oneWayHours || 0), 0);
                        const mHrs = e?.drivingHours;
                        const used = mHrs !== undefined && mHrs > 0 ? mHrs : aHrs;
                        return sum + used;
                      }, 0)}h
                    </td>
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap border-l border-slate-200 bg-amber-100/50 text-slate-900">
                      {formatCurrency(item.fatigueAllowanceTotal)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap bg-sky-100/50 text-slate-900">
                      {formatCurrency(item.travelAllowanceTotal)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap bg-violet-100/50 text-slate-900">
                      {formatCurrency(item.overnightAllowanceTotal)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap font-bold text-blue-700 bg-blue-100/60">
                      {formatCurrency(item.grandTotal)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          /* 單日明細 */
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
            <div className="flex items-center gap-1.5 px-4 py-2.5 bg-gradient-to-r from-slate-50 to-blue-50 border-b border-slate-200">
              <Clock className="w-4 h-4 text-slate-600" />
              <span className="text-sm font-semibold text-slate-700">當日資訊</span>
            </div>
            <div className="p-4 space-y-3 text-sm">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">日期</div>
                  <div className="font-mono font-medium text-slate-800">
                    {item.date}
                    <span className="text-slate-400 text-[11px] ml-1">({getWeekday(item.date)})</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">出發時間</div>
                  <div className="font-mono font-medium text-slate-800">{item.startTime || '--:--'}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">結束時間</div>
                  <div className="font-mono font-medium text-slate-800">{item.endTime || '--:--'}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">單程行駛</div>
                  <div className="font-mono font-medium text-slate-800">
                    {item.effectiveOneWayHours ?? item.oneWayHours ?? 0}h
                  </div>
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-0.5">目的地</div>
                {item.destinations && item.destinations.length > 0 ? (
                  <ul className="space-y-0.5">
                    {item.destinations.map((d, i) => (
                      <li key={i} className="text-slate-800">
                        {d.address}
                        <span className="text-slate-400 ml-1 text-xs">（單程 {d.oneWayHours}h）</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-slate-700">{item.destination || <span className="text-slate-400 italic">(無)</span>}</div>
                )}
              </div>
              {/* 金額明細 (per-day = 整筆 since single-day) */}
              <div className="grid grid-cols-4 gap-2 pt-3 border-t border-slate-100">
                <div className="text-right">
                  <div className="text-[11px] text-slate-500">疲勞</div>
                  <div className="font-mono text-slate-800">{formatCurrency(item.fatigueAllowanceTotal)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-slate-500">車程</div>
                  <div className="font-mono text-slate-800">{formatCurrency(item.travelAllowanceTotal)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-slate-500">過夜</div>
                  <div className="font-mono text-slate-800">{formatCurrency(item.overnightAllowanceTotal)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-blue-700 font-medium">合計</div>
                  <div className="font-mono font-bold text-blue-700">{formatCurrency(item.grandTotal)}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 金額明細：4 張 stat 卡 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-lg border border-amber-100 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-1.5 text-xs text-amber-700 font-medium mb-1">
              <AlertCircle className="w-3.5 h-3.5" />
              疲勞津貼總額
            </div>
            <div className="text-lg font-bold font-mono text-slate-800">
              {formatCurrency(item.fatigueAllowanceTotal)}
            </div>
          </div>
          <div className="bg-white rounded-lg border border-sky-100 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-1.5 text-xs text-sky-700 font-medium mb-1">
              <Car className="w-3.5 h-3.5" />
              車程津貼總額
            </div>
            <div className="text-lg font-bold font-mono text-slate-800">
              {formatCurrency(item.travelAllowanceTotal)}
            </div>
          </div>
          <div className="bg-white rounded-lg border border-violet-100 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-1.5 text-xs text-violet-700 font-medium mb-1">
              <Moon className="w-3.5 h-3.5" />
              過夜津貼總額
            </div>
            <div className="text-lg font-bold font-mono text-slate-800">
              {formatCurrency(item.overnightAllowanceTotal)}
            </div>
          </div>
          <div className="bg-gradient-to-br from-blue-600 to-blue-700 rounded-lg px-4 py-3 shadow-sm text-white">
            <div className="flex items-center gap-1.5 text-xs text-blue-100 font-medium mb-1">
              <Users className="w-3.5 h-3.5" />
              每人均分
            </div>
            <div className="text-lg font-bold font-mono">
              {formatCurrency(item.grandTotal / headcount)}
            </div>
            <div className="text-[10px] text-blue-100 mt-0.5">
              共 {headcount} 人 / 總額 {formatCurrency(item.grandTotal)}
            </div>
          </div>
        </div>
      </div>
    );
  };

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

        {/* 連線/讀取資料失敗時顯示給使用者 */}
        {authError && !isDemoMode && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div className="text-sm">
              <div className="font-semibold mb-0.5">資料庫連線異常</div>
              <div className="text-xs text-red-600">{authError}</div>
            </div>
          </div>
        )}

        {activeTab === 'form' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Left: The Form */}
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="bg-slate-50 px-6 py-4 border-b border-slate-200">
                  <div className="flex items-center gap-2">
                    <FileText className="w-5 h-5 text-blue-600" />
                    <h2 className="font-semibold text-slate-700">{editingRecordId ? '✏️ 修改申請單' : '新申請單'}</h2>
                  </div>
                  {editingRecordId && (
                    <div className="mt-2 flex items-center gap-3 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-sm text-amber-800">
                      <span>⚠️ 您正在修改已送出的申請單，儲存後將覆蓋原始記錄。</span>
                      <button
                        type="button"
                        onClick={() => setEditingRecordId(null)}
                        className="ml-auto text-xs underline text-amber-600 hover:text-amber-900 whitespace-nowrap"
                      >取消修改</button>
                    </div>
                  )}
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



                    <div className="space-y-3">
                      {formData.destinations.map((dest, index) => (
                        <div key={index} className="bg-white p-3 rounded-lg border border-green-200">
                          {/* Per-destination quick-select */}
                          <div className="mb-2 relative">
                            <MapIcon className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                            <select
                              value=""
                              onChange={(e) => handleLocationSelect(e, index)}
                              className="w-full pl-9 pr-8 py-1.5 border border-green-200 bg-green-50 rounded-lg text-xs text-slate-700 focus:ring-2 focus:ring-green-400 outline-none appearance-none cursor-pointer"
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
                            <div className="absolute right-2.5 top-2 pointer-events-none text-slate-400">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <span className="text-xs font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded">目的地 {index + 1}</span>
                            {dest.oneWayHours > 0 && (
                              <span className="text-xs text-slate-400">此段 {dest.oneWayHours}H</span>
                            )}
                            {/* Day selector — only shown for multi-day trips */}
                            {formData.nights > 0 && (
                              <select
                                value={dest.dayIndex ?? 0}
                                onChange={(e) => handleDestinationChange(index, 'dayIndex', Number(e.target.value))}
                                className="ml-auto text-xs border border-indigo-200 rounded-md px-2 py-1 bg-indigo-50 text-indigo-700 font-semibold focus:ring-2 focus:ring-indigo-300 outline-none cursor-pointer"
                                title="指定出差日"
                              >
                                {Array.from({ length: formData.nights + 1 }, (_, d) => (
                                  <option key={d} value={d}>出差日 {d + 1}</option>
                                ))}
                              </select>
                            )}
                            {formData.destinations.length > 1 && (
                              <button type="button" onClick={() => removeDestination(index)}
                                className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors">
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
                                title="使用 AI 估算此段車程（起點為上一地點）"
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
                    {/* Only show manual hours override for single-day (multi-day uses per-day card) */}
                    {formData.nights === 0 && (
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">總車程時數（各段加總，可手動覆蓋）</label>
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
                        自動加總所有段: {formData.destinations.reduce((s, d) => s + (d.oneWayHours || 0), 0)}H，每1.5小時補助$30
                      </p>
                    </div>
                    )}

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
                            {/* 出發點 + 今日目的地彙整 + 手動時數覆蓋 */}
                            <div className="mt-3 space-y-3">
                              {/* Starting point */}
                              <div>
                                <label className="block text-xs font-medium text-indigo-700 mb-1">
                                  當天出發點 <span className="text-indigo-400 font-normal">（自動帶入，可手動修改）</span>
                                </label>
                                <input
                                  type="text"
                                  value={entry.startingPoint ?? (index === 0 ? '北斗公司' : '')}
                                  onChange={(e) => handleDayEntryChange(index, 'startingPoint', e.target.value)}
                                  placeholder={index === 0 ? '北斗公司' : '上一天最後目的地'}
                                  className="w-full px-3 py-2 border border-indigo-200 rounded-lg focus:ring-2 focus:ring-indigo-400 outline-none bg-white text-slate-900 text-sm"
                                />
                              </div>
                              {/* Today's assigned destinations */}
                              {(() => {
                                const todayDests = formData.destinations.filter(d => (d.dayIndex ?? 0) === index);
                                const todayHours = todayDests.reduce((h, d) => h + (d.oneWayHours || 0), 0);
                                return (
                                  <div className="bg-indigo-100/60 rounded-lg p-2">
                                    <p className="text-xs font-medium text-indigo-700 mb-1">今日行程（共 {todayDests.length} 段）</p>
                                    {todayDests.length === 0 ? (
                                      <p className="text-xs text-slate-400 italic">尚未在「出差地點」指定出差日 {index + 1} 的目的地</p>
                                    ) : (
                                      <div className="space-y-1">
                                        {todayDests.map((d, di) => (
                                          <div key={di} className="flex items-center gap-2 text-xs text-slate-700">
                                            <span className="text-indigo-400">▸</span>
                                            <span className="flex-1">{d.address || '（未填地址）'}</span>
                                            <span className="text-slate-400 shrink-0">{d.oneWayHours}H</span>
                                          </div>
                                        ))}
                                        <div className="border-t border-indigo-200 mt-1 pt-1 flex justify-between text-xs">
                                          <span className="text-indigo-600 font-medium">合計行駛時數</span>
                                          <span className="text-indigo-800 font-bold">{todayHours}H → ≈ {formatCurrency(Math.floor(todayHours / 1.5) * 30)} 津貼</span>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                              {/* Manual override */}
                              <div className="flex items-center gap-2">
                                <label className="text-xs text-slate-400 shrink-0">手動覆蓋時數：</label>
                                <div className="relative flex-1">
                                  <input
                                    type="number"
                                    step="0.5"
                                    min="0"
                                    value={entry.drivingHours ?? ''}
                                    onChange={(e) => handleDayEntryChange(index, 'drivingHours', Number(e.target.value))}
                                    placeholder="留空則使用上方計算值"
                                    className="w-full pl-3 pr-10 py-1.5 border border-dashed border-slate-300 rounded-lg focus:ring-1 focus:ring-indigo-300 outline-none bg-white/70 text-slate-700 text-xs"
                                  />
                                  <span className="absolute right-3 top-1.5 text-slate-400 text-xs">小時</span>
                                </div>
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
                          {editingRecordId ? `儲存修改（${formData.applicants.length} 人）` : `提交 ${formData.applicants.length} 人申請單`}
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
                      <div className="text-slate-600 text-sm font-medium">車程加給 <span className="text-xs text-slate-400">{formData.nights > 0 ? "(各日合計)" : "(來回)"}</span></div>
                      <div className="font-mono font-bold text-slate-800">{formatCurrency(calculation.travelTotal)}</div>
                    </div>
                    <div className="text-xs text-slate-400 space-y-0.5">
                      {formData.nights > 0 ? (
                        <div>各天行駛時數加總 = {formatCurrency(calculation.travelTotal)}</div>
                      ) : (
                        <>
                          <div>各段加總 {formData.effectiveOneWayHours}H ÷ 1.5 = {calculation.travelUnits} 單位 × $30 = {formatCurrency(calculation.singleTripAllowance)}/趟</div>
                          <div>來回: {formatCurrency(calculation.singleTripAllowance)} × 2 = {formatCurrency(calculation.travelTotal)}</div>
                        </>
                      )}
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
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-800">個人申請紀錄</h2>
                  <p className="text-sm text-slate-500">申請人：{currentUser.name} ({currentUser.id})</p>
                </div>
              </div>

              {/* Filter Panel */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-4 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-slate-600 whitespace-nowrap">篩選模式</label>
                  <select
                    value={myFilterMode}
                    onChange={(e) => { setMyFilterMode(e.target.value as any); setMyFilterValue(''); }}
                    className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    <option value="all">全部</option>
                    <option value="month">月</option>
                    <option value="year">年</option>
                    <option value="day">日</option>
                  </select>
                </div>
                {myFilterMode === 'month' && (
                  <input
                    type="month"
                    value={myFilterValue}
                    onChange={(e) => setMyFilterValue(e.target.value)}
                    className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                )}
                {myFilterMode === 'year' && (
                  <input
                    type="number"
                    placeholder="YYYY"
                    min="2020"
                    max="2035"
                    value={myFilterValue}
                    onChange={(e) => setMyFilterValue(e.target.value)}
                    className="w-24 border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                )}
                {myFilterMode === 'day' && (
                  <input
                    type="date"
                    value={myFilterValue}
                    onChange={(e) => setMyFilterValue(e.target.value)}
                    className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                )}
                <div className="relative flex-1 min-w-[160px]">
                  <input
                    type="text"
                    placeholder="搜尋關鍵字（姓名、地點、事由、日期）"
                    value={myFilterKeyword}
                    onChange={(e) => setMyFilterKeyword(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-1.5 pr-7 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                  {myFilterKeyword && (
                    <button
                      onClick={() => setMyFilterKeyword('')}
                      className="absolute right-2 top-1.5 text-slate-400 hover:text-slate-600 text-xs"
                      title="清除"
                    >✕</button>
                  )}
                </div>
                <span className="text-xs text-slate-400 whitespace-nowrap">
                  顯示 {filteredMyHistory.length} / {myHistory.length} 筆
                </span>
              </div>

              {/* 桌面版表格（≥md） */}
              <div className="hidden md:block overflow-x-auto">
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
                    {filteredMyHistory.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                          {myHistory.length === 0 ? '尚無申請資料' : '找不到符合條件的紀錄'}
                        </td>
                      </tr>
                    ) : (
                      filteredMyHistory.map((item) => {
                        const isSubmitter = item.submitterId === currentUser.id;
                        const isMultiDay = !!(item.nights && item.nights > 0);
                        return (
                          <tr key={item.id} className="bg-white border-b hover:bg-slate-50">
                            <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                              {formatTimestamp(item.timestamp)}
                            </td>
                            <td className="px-4 py-3 font-medium text-slate-900 whitespace-nowrap">
                              {item.date}
                              {isMultiDay && (
                                <div className="mt-1 inline-block px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 bg-blue-100 rounded">
                                  {item.nights! + 1}天{item.nights}夜
                                </div>
                              )}
                            </td>
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
                              {isSubmitter && (
                                <button
                                  type="button"
                                  onClick={() => handleEditRecord(item)}
                                  className="mt-1.5 block mx-auto text-xs text-blue-500 hover:text-blue-700 underline transition-colors"
                                >✏️ 編輯</button>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* 手機版卡片（<md）— 同仁多用手機操作 */}
              <div className="md:hidden space-y-3">
                {filteredMyHistory.length === 0 ? (
                  <div className="text-center text-slate-400 text-sm py-8">
                    {myHistory.length === 0 ? '尚無申請資料' : '找不到符合條件的紀錄'}
                  </div>
                ) : (
                  filteredMyHistory.map((item) => {
                    const isSubmitter = item.submitterId === currentUser.id;
                    const isMultiDay = !!(item.nights && item.nights > 0);
                    const endDate = isMultiDay ? addDays(item.date, item.nights!) : null;
                    return (
                      <div
                        key={item.id}
                        className="bg-white border border-slate-200 rounded-lg p-3 shadow-sm"
                      >
                        {/* Top: 日期 + 身份 badge */}
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <div className="font-bold text-slate-900 font-mono text-base">
                              {item.date}
                              {isMultiDay && (
                                <span className="text-slate-400 mx-1">~</span>
                              )}
                              {isMultiDay && (
                                <span className="font-mono">{endDate!.slice(5)}</span>
                              )}
                            </div>
                            {isMultiDay && (
                              <span className="inline-block mt-1 px-2 py-0.5 text-[10px] font-semibold text-blue-700 bg-blue-100 rounded-full">
                                {item.nights! + 1}天{item.nights}夜
                              </span>
                            )}
                          </div>
                          {isSubmitter ? (
                            <span className="inline-block px-2 py-1 text-[10px] font-semibold text-green-700 bg-green-100 rounded-full whitespace-nowrap">
                              我提交的
                            </span>
                          ) : (
                            <span className="inline-block px-2 py-1 text-[10px] font-semibold text-blue-700 bg-blue-100 rounded-full whitespace-nowrap">
                              參與出差
                            </span>
                          )}
                        </div>

                        {/* 出差人員 */}
                        <div className="text-sm text-slate-700 mb-1">
                          <Users className="inline w-3.5 h-3.5 text-slate-400 mr-1 -mt-0.5" />
                          {item.applicants?.join('、') || 'N/A'}
                        </div>

                        {/* 地點 */}
                        <div className="text-sm text-slate-700 mb-1">
                          <MapPin className="inline w-3.5 h-3.5 text-slate-400 mr-1 -mt-0.5" />
                          {item.destinations
                            ? item.destinations.map((d: any) => d.address).join(' → ')
                            : item.destination || '(無)'}
                        </div>

                        {/* 事由 */}
                        {item.reason && (
                          <div className="text-xs text-slate-500 mb-2 ml-4">
                            事由：{item.reason}
                          </div>
                        )}

                        {/* Bottom: 金額 + 編輯 */}
                        <div className="flex justify-between items-end pt-2 border-t border-slate-100">
                          <div>
                            <div className="text-[10px] text-slate-400">提交時間</div>
                            <div className="text-[11px] text-slate-500">{formatTimestamp(item.timestamp)}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] text-slate-400">總金額</div>
                            <div className="text-xl font-bold text-blue-600 font-mono leading-none">
                              {formatCurrency(item.grandTotal)}
                            </div>
                          </div>
                        </div>
                        {isSubmitter && (
                          <button
                            type="button"
                            onClick={() => handleEditRecord(item)}
                            className="mt-2 w-full py-1.5 text-xs text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors border border-blue-200"
                          >
                            ✏️ 編輯這筆紀錄
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* Admin Dashboard (Full Records) */}
        {activeTab === 'admin' && currentUser.id === ADMIN_ID && (
          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <div className="mb-6">
                <h2 className="text-xl font-bold text-slate-800">出差津貼彙總表</h2>
                <p className="text-sm text-slate-500">供管理部 (小井) 月結使用</p>
              </div>

              {/* Export Tools Card */}
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Download className="w-4 h-4 text-green-700" />
                  <span className="text-sm font-semibold text-green-800">匯出工具</span>
                  <span className="text-xs text-green-600">（選擇月份下載 Excel 月報）</span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-green-600" />
                    <input
                      type="month"
                      value={exportMonth}
                      onChange={e => setExportMonth(e.target.value)}
                      className="border border-green-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-green-500 outline-none"
                    />
                  </div>
                  <button
                    onClick={downloadMonthlyExcel}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium"
                  >
                    <Download className="w-4 h-4" />
                    下載月報 Excel
                  </button>
                </div>
              </div>

              {/* Filter Panel */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-4 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-slate-600 whitespace-nowrap">篩選模式</label>
                  <select
                    value={adminFilterMode}
                    onChange={(e) => { setAdminFilterMode(e.target.value as any); setAdminFilterValue(''); }}
                    className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    <option value="all">全部</option>
                    <option value="month">月</option>
                    <option value="year">年</option>
                    <option value="day">日</option>
                  </select>
                </div>
                {adminFilterMode === 'month' && (
                  <input
                    type="month"
                    value={adminFilterValue}
                    onChange={(e) => setAdminFilterValue(e.target.value)}
                    className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                )}
                {adminFilterMode === 'year' && (
                  <input
                    type="number"
                    placeholder="YYYY"
                    min="2020"
                    max="2035"
                    value={adminFilterValue}
                    onChange={(e) => setAdminFilterValue(e.target.value)}
                    className="w-24 border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                )}
                {adminFilterMode === 'day' && (
                  <input
                    type="date"
                    value={adminFilterValue}
                    onChange={(e) => setAdminFilterValue(e.target.value)}
                    className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                )}
                <div className="relative flex-1 min-w-[160px]">
                  <input
                    type="text"
                    placeholder="搜尋關鍵字（姓名、地點、事由、日期）"
                    value={adminFilterKeyword}
                    onChange={(e) => setAdminFilterKeyword(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-1.5 pr-7 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                  {adminFilterKeyword && (
                    <button
                      onClick={() => setAdminFilterKeyword('')}
                      className="absolute right-2 top-1.5 text-slate-400 hover:text-slate-600 text-xs"
                      title="清除"
                    >✕</button>
                  )}
                </div>
              </div>

              <div className="flex justify-between items-center mb-4">
                <span className="text-sm text-slate-500">
                  顯示 {filteredAdminHistory.length} / {history.length} 筆
                </span>
                <div className="text-right">
                  <div className="text-xs text-slate-500">篩選結果總金額</div>
                  <div className="text-2xl font-bold text-blue-600">
                    {formatCurrency(filteredAdminHistory.reduce((sum, item) => sum + (item.grandTotal || 0), 0))}
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left text-slate-600">
                  <thead className="text-xs text-slate-700 uppercase bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-2 py-3 text-center whitespace-nowrap w-8"></th>
                      <th className="px-2 py-3 text-center whitespace-nowrap w-10">刪除</th>
                      <th className="px-4 py-3 whitespace-nowrap">提交時間</th>
                      <th className="px-4 py-3 whitespace-nowrap">提交人</th>
                      <th className="px-4 py-3 whitespace-nowrap">出差日期</th>
                      <th className="px-4 py-3 whitespace-nowrap">出差人員</th>
                      <th className="px-4 py-3 whitespace-nowrap">地點</th>
                      <th className="px-4 py-3 whitespace-nowrap">出發時間</th>
                      <th className="px-4 py-3 whitespace-nowrap">結束時間</th>
                      <th className="px-4 py-3 text-right whitespace-nowrap">疲勞</th>
                      <th className="px-4 py-3 text-right whitespace-nowrap">車程</th>
                      <th className="px-4 py-3 text-right whitespace-nowrap">跨日</th>
                      <th className="px-4 py-3 text-right font-bold text-slate-900 whitespace-nowrap">總計</th>
                      <th className="px-4 py-3 text-center whitespace-nowrap">狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAdminHistory.length === 0 ? (
                      <tr>
                        <td colSpan={14} className="px-4 py-8 text-center text-slate-400">
                          {history.length === 0 ? '目前尚無申請資料' : '找不到符合條件的紀錄'}
                        </td>
                      </tr>
                    ) : (
                      filteredAdminHistory.map((item) => {
                        const rowKey = item.id || `${item.submitterId}-${item.date}-${item.timestamp}`;
                        const isExpanded = expandedAdminRows.has(rowKey);
                        const tripTimes = getTripTimes(item);
                        const isMultiDay = !!(item.nights && item.nights > 0 && item.dayEntries && item.dayEntries.length > 0);
                        const dupMatches = (item.id && adminDuplicateMap[item.id]) || [];
                        const hasDup = dupMatches.length > 0;
                        return (
                          <Fragment key={rowKey}>
                            <tr className={`border-b hover:bg-slate-50 ${hasDup ? 'bg-amber-50/30' : 'bg-white'}`}>
                              <td className="px-2 py-3 text-center">
                                <button
                                  onClick={() => toggleAdminRow(rowKey)}
                                  className={`p-1.5 rounded-lg transition-all duration-200 ${
                                    isExpanded
                                      ? 'text-blue-600 bg-blue-50'
                                      : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50'
                                  }`}
                                  title={isExpanded ? '收起明細' : '展開明細'}
                                  aria-expanded={isExpanded}
                                >
                                  <ChevronRight
                                    className={`w-4 h-4 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                                  />
                                </button>
                              </td>
                              <td className="px-2 py-3 text-center">
                                <button
                                  onClick={() => handleDeleteRecord(item)}
                                  className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                  title="刪除此筆紀錄"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </td>
                              <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                                {formatTimestamp(item.timestamp)}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                <div className="font-medium text-slate-900">{item.submitterName || '未知'}</div>
                                <div className="text-xs text-slate-400">{item.submitterId}</div>
                              </td>
                              <td className="px-4 py-3 font-medium text-slate-900 whitespace-nowrap">
                                <div>{item.date}</div>
                                {isMultiDay && (
                                  <div className="mt-1 flex items-center gap-1">
                                    <span className="text-xs text-slate-400 font-mono">~{addDays(item.date, item.nights!).slice(5)}</span>
                                    <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 bg-blue-100 rounded">
                                      {item.nights! + 1}天{item.nights}夜
                                    </span>
                                  </div>
                                )}
                              </td>
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
                              <td className="px-4 py-3 text-xs whitespace-nowrap font-mono text-slate-700">
                                {tripTimes.start}
                              </td>
                              <td className="px-4 py-3 text-xs whitespace-nowrap font-mono text-slate-700">
                                {tripTimes.end}
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
                              <td className="px-4 py-3 text-center space-y-1">
                                {item.eligibleForLateStart && (
                                  <span className="inline-block px-2 py-1 text-xs font-semibold text-amber-700 bg-amber-100 rounded-full whitespace-nowrap">
                                    延後上班
                                  </span>
                                )}
                                {hasDup && (
                                  <span
                                    className="inline-block px-2 py-1 text-xs font-semibold text-rose-700 bg-rose-100 rounded-full whitespace-nowrap cursor-help"
                                    title={`與 ${dupMatches.length} 筆紀錄日期區間 + 申請人有重疊。展開明細可看詳情。`}
                                  >
                                    ⚠ 疑似重複 ×{dupMatches.length}
                                  </span>
                                )}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="bg-gradient-to-b from-blue-50/60 to-slate-50/40 border-b-2 border-blue-200">
                                <td colSpan={14} className="px-6 py-5">
                                  <AdminRecordDetail item={item} dupMatches={dupMatches} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

      </main>

      {/* 重複登打警告 modal */}
      {duplicateWarning && duplicateWarning.length > 0 && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            // 點背景關閉
            setDuplicateWarning(null);
            setDuplicateConfirmCheck(false);
          }}
        >
          <div
            className="bg-white rounded-xl max-w-2xl w-full p-6 shadow-2xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="bg-amber-100 rounded-full p-2 flex-shrink-0">
                <AlertCircle className="w-6 h-6 text-amber-600" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-slate-900">偵測到可能的重複申請</h3>
                <p className="text-sm text-slate-600 mt-1">
                  以下 {duplicateWarning.length} 筆既有紀錄與你這次提交的<strong>日期區間</strong>與<strong>申請人</strong>有重疊：
                </p>
              </div>
            </div>

            <div className="space-y-2 mb-4 overflow-y-auto flex-1 pr-1">
              {duplicateWarning.map((m, i) => {
                const recEnd = addDays(m.record.date!, m.record.nights || 0);
                const isMultiDay = (m.record.nights || 0) > 0;
                return (
                  <div key={i} className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
                    <div className="flex items-center justify-between mb-1">
                      <div className="font-mono font-medium text-slate-800">
                        {m.record.date}
                        {isMultiDay && <> ~ {recEnd}</>}
                        {isMultiDay && (
                          <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 bg-blue-100 rounded">
                            {(m.record.nights || 0) + 1}天{m.record.nights}夜
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500">
                        提交人：{m.record.submitterName || '未知'}
                        <span className="text-slate-400 ml-1">({m.record.submitterId})</span>
                      </div>
                    </div>
                    <div className="text-xs text-slate-700 mb-1">
                      <span className="text-slate-500">申請人：</span>
                      {m.record.applicants?.map((a, j) => {
                        const isOverlap = m.overlappingApplicants.includes(a);
                        return (
                          <span
                            key={j}
                            className={isOverlap ? 'font-semibold text-amber-800 bg-amber-200 px-1 rounded mr-1' : 'text-slate-600 mr-1'}
                          >
                            {a}
                          </span>
                        );
                      })}
                    </div>
                    <div className="text-xs text-amber-700 font-medium border-t border-amber-200 pt-1 mt-1">
                      ⚠ 重疊：{m.overlappingApplicants.join('、')}
                      {' '}在 <span className="font-mono">{m.overlapStart}</span>
                      {m.overlapStart !== m.overlapEnd && <> ~ <span className="font-mono">{m.overlapEnd}</span></>}
                    </div>
                    {m.record.reason && (
                      <div className="text-[11px] text-slate-500 mt-1">
                        事由：{m.record.reason}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <label className="flex items-start gap-2 mb-4 text-sm cursor-pointer p-2 -mx-2 hover:bg-slate-50 rounded">
              <input
                type="checkbox"
                checked={duplicateConfirmCheck}
                onChange={e => setDuplicateConfirmCheck(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-slate-700">
                我已確認此筆並非重複登打，仍要提交
                <span className="block text-xs text-slate-400 mt-0.5">
                  （勾選後才能按下「確認提交」）
                </span>
              </span>
            </label>

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={() => {
                  setDuplicateWarning(null);
                  setDuplicateConfirmCheck(false);
                }}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
              >
                取消，回去檢查
              </button>
              <button
                type="button"
                disabled={!duplicateConfirmCheck || isSubmitting}
                onClick={() => void performSubmit()}
                className="px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {isSubmitting ? '提交中...' : '確認提交'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}









