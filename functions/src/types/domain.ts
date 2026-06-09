import type * as admin from "firebase-admin";

type Timestamp = admin.firestore.Timestamp | admin.firestore.FieldValue;

// ─── Studio Owner (users collection) ─────────────────────────────────────────

export interface StudioOwner {
  authUid: string;
  email: string;
  firstName: string;
  lastName: string;
  studioName: string;
  studioAddressLine1: string;
  studioAddressLine2: string | null;
  city: string;
  state: string;
  zip: string;
  studioImageUrl: string | null;
  membership: "individual_instructor" | "studio_owner" | "event_organizer" | "ultimate";
  facebook: string | null;
  instagram: string | null;
  tiktok: string | null;
  youtube: string | null;
  roles: string[];
  stripeCustomerId?: string;
  stripeConnectedCustomers?: Record<string, string>; // map of connectedAccountId → connectedCustomerId
  stripeSubscriptionId?: string;
  stripeSubscriptionStatus?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Student ──────────────────────────────────────────────────────────────────

export interface Student {
  authUid?: string;
  studioOwnerId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  notes?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Dance Class ──────────────────────────────────────────────────────────────

export interface DanceClass {
  studioOwnerId: string;
  name: string;
  description?: string | null;
  genre?: string | null;
  difficulty?: string | null;
  imageUrl?: string | null;
  instructorId?: string | null;
  schedule?: ClassSchedule[];
  capacity?: number | null;
  price?: number | null;
  lat?: number | null;
  lng?: number | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ClassSchedule {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  location?: string | null;
}

// ─── Instructor ───────────────────────────────────────────────────────────────

export interface Instructor {
  studioOwnerId: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  bio?: string | null;
  imageUrl?: string | null;
  specialties?: string[];
  availability?: InstructorAvailability[];
  stripeConnectAccountId?: string | null;
  hourlyRate?: number | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface InstructorAvailability {
  dayOfWeek: number;
  slots: Array<{ startTime: string; endTime: string }>;
}

// ─── Performer Registration ───────────────────────────────────────────────────

export interface PerformerQuestion {
  id: string;
  label: string;
  required: boolean;
  order: number;
  type?: 'text' | 'state';
}

export interface PerformerApplication {
  eventId: string;
  studioOwnerId: string;
  teamName: string;
  answers: Record<string, string>;
  status: "pending" | "approved" | "declined";
  paymentUrl?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Vendor Registration ──────────────────────────────────────────────────────

export interface VendorQuestion {
  id: string;
  label: string;
  required: boolean;
  order: number;
}

export interface VendorApplication {
  id?: string;
  eventId: string;
  studioOwnerId: string;
  businessName: string;
  email: string;
  answers: Record<string, string>;
  status: "pending" | "approved" | "declined";
  declineReason?: string | null;
  paymentUrl?: string | null;
  submittedBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Event ────────────────────────────────────────────────────────────────────

export interface ScheduleSlot {
  date: string;          // YYYY-MM-DD
  startTime: string;     // HH:mm (24-hour)
  endTime: string;       // HH:mm (24-hour)
  room: string;
  className: string;
  instructors: string[];
}

export interface Event {
  studioOwnerId: string;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  date: string;
  startTime?: string | null;
  endTime?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  lat?: number | null;
  lng?: number | null;
  price?: number | null;
  capacity?: number | null;
  stripePriceId?: string | null;
  stripeProductId?: string | null;
  rooms?: string[];
  schedule?: ScheduleSlot[];
  showSchedule?: boolean;
  enablePerformerRegistration?: boolean;
  performerQuestionnaire?: PerformerQuestion[];
  enableVendorRegistration?: boolean;
  vendorQuestionnaire?: VendorQuestion[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Workshop ─────────────────────────────────────────────────────────────────

export interface Workshop {
  studioOwnerId: string;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  dates?: string[];
  startTime?: string | null;
  endTime?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  lat?: number | null;
  lng?: number | null;
  price?: number | null;
  capacity?: number | null;
  stripePriceId?: string | null;
  stripeProductId?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Package ──────────────────────────────────────────────────────────────────

export interface Package {
  studioOwnerId: string;
  name: string;
  description?: string | null;
  classCount: number;
  price: number;
  expirationDays?: number | null;
  stripePriceId?: string | null;
  stripeProductId?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Credit ───────────────────────────────────────────────────────────────────

export interface CreditEntry {
  studentId: string;
  studioOwnerId: string;
  classId?: string | null;
  packageId?: string | null;
  creditsRemaining: number;
  creditsTotal: number;
  expiresAt?: Timestamp | null;
  purchasedAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Attendance ───────────────────────────────────────────────────────────────

export interface AttendanceRecord {
  studentId: string;
  studioOwnerId: string;
  classId: string;
  attendedOn: string;
  paidOn?: string | null;
  paymentMethod?: string | null;
  notes?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Booking ──────────────────────────────────────────────────────────────────

export interface Booking {
  studentId: string;
  authUid: string;
  instructorId: string;
  studioId?: string | null;
  date: string;
  timeSlot: { startTime: string; endTime: string };
  status: "pending" | "confirmed" | "cancelled";
  paymentStatus: "pending" | "paid" | "refunded";
  stripeSessionId?: string | null;
  notes?: string | null;
  contactInfo: { email: string | null; phone: string | null };
  amountPaid: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Review ───────────────────────────────────────────────────────────────────

export interface Review {
  studioOwnerId: string;
  studentId?: string | null;
  authorName: string;
  rating: number;
  comment?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
