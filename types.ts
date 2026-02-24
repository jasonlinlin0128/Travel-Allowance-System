export interface Location {
  region: string;
  name: string;
  hours: number;
}

export interface Employee {
  id: string;
  name: string;
}

export interface Destination {
  address: string;
  oneWayHours: number;
}

export interface TravelRequest {
  id?: string;

  // Submitter Info (Logged in user)
  submitterId: string;
  submitterName: string;

  userId: string; // Firebase Auth UID (keep for backend security rules if needed)
  applicants: string[];
  reason: string;
  date: string;
  startTime: string;
  endTime: string;
  passengers: number;
  nights: number;

  // Multi-destination (new)
  destinations?: Destination[];
  effectiveOneWayHours?: number;

  // Legacy single destination (backward compat)
  destination?: string;
  oneWayHours?: number;

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

export interface CalculationResult {
  fatigueTotal: number;
  travelTotal: number;
  overnightTotal: number;
  grandTotal: number;
  perPersonFatigue: number;
  perPersonOvernight: number;
  perPersonTravel: number;
  lateStart: boolean;
  rest: number;
  headcount: number;
  travelUnits: number;
  singleTripAllowance: number;
}