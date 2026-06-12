import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import express, { Request, Response } from "express";
import cors from "cors";
import { verifyToken } from "../utils/auth";
import {
  sendJsonResponse,
  sendErrorResponse,
  handleError,
  corsOptions,
  isAllowedOrigin,
  applySecurityMiddleware,
} from "../utils/http";
import { getStripeClient } from "../services/stripe.service";


interface GCPLogEntry {
  insertId?: string;
  timestamp: string;
  severity?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  resource?: {
    type?: string;
    labels?: Record<string, string>;
  };
}

interface SchedulerJob {
  name: string;
  schedule?: string;
  state?: string;
  lastAttemptTime?: string;
  status?: { code?: number; message?: string };
}

interface CloudFunctionV2 {
  name: string;
  state?: string;
  updateTime?: string;
  stateMessages?: { severity?: string; type?: string; message?: string }[];
  serviceConfig?: {
    uri?: string;
    availableMemory?: string;
    timeoutSeconds?: number;
  };
  buildConfig?: { runtime?: string };
}

const app = express();

app.options("*", (req, res) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  return res.status(204).send();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  next();
});

app.use(cors(corsOptions));
app.use(express.json());
applySecurityMiddleware(app);

async function getGCPToken(): Promise<string> {
  const resp = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  const data = await resp.json() as { access_token: string };
  return data.access_token;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function getProjectId(): string {
  return process.env["GCLOUD_PROJECT"] ?? process.env["GCP_PROJECT"] ?? admin.app().options.projectId ?? "";
}

app.get("/", async (req: Request, res: Response) => {
  try {
    let user;
    try { user = await verifyToken(req); } catch (authError) { return handleError(req, res, authError); }

    if (!user.isAdmin) {
      return sendErrorResponse(req, res, 403, "Forbidden", "Admin access only");
    }

    const projectId = getProjectId();
    const [stripe, token] = await Promise.all([
      getStripeClient(),
      getGCPToken(),
    ]);

    // Service pings
    const pingFirestore = async () => {
      const t = Date.now();
      await withTimeout(admin.firestore().doc("_health/ping").get(), 3000);
      return Date.now() - t;
    };
    const pingAuth = async () => {
      const t = Date.now();
      await withTimeout(admin.auth().listUsers(1), 3000);
      return Date.now() - t;
    };
    const pingStripe = async () => {
      const t = Date.now();
      await withTimeout(stripe.balance.retrieve(), 3000);
      return Date.now() - t;
    };

    // Cloud Functions v2: list all deployed functions (paginated)
    const fetchCloudFunctions = async (): Promise<CloudFunctionV2[]> => {
      const all: CloudFunctionV2[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(
          `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/us-central1/functions`,
        );
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const resp = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) break;
        const data = await resp.json() as { functions?: CloudFunctionV2[]; nextPageToken?: string };
        if (data.functions) all.push(...data.functions);
        pageToken = data.nextPageToken;
      } while (pageToken);
      return all;
    };

    // Cloud Logging: all function log entries
    const fetchLogs = async (): Promise<GCPLogEntry[]> => {
      const body = {
        resourceNames: [`projects/${projectId}`],
        filter: '(resource.type="cloud_run_revision" OR resource.type="cloud_function") severity>="INFO"',
        pageSize: 100,
        orderBy: "timestamp desc",
      };
      const resp = await fetch("https://logging.googleapis.com/v2/entries:list", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) return [];
      const data = await resp.json() as { entries?: GCPLogEntry[] };
      return data.entries ?? [];
    };

    // Cloud Scheduler: job list
    const fetchSchedulerJobs = async (): Promise<SchedulerJob[]> => {
      const resp = await fetch(
        `https://cloudscheduler.googleapis.com/v1/projects/${projectId}/locations/us-central1/jobs`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!resp.ok) return [];
      const data = await resp.json() as { jobs?: SchedulerJob[] };
      return data.jobs ?? [];
    };

    // Cloud Logging: scheduler error entries
    const fetchSchedulerErrors = async (): Promise<GCPLogEntry[]> => {
      const body = {
        resourceNames: [`projects/${projectId}`],
        filter: 'resource.type="cloud_scheduler_job" severity="ERROR"',
        pageSize: 20,
        orderBy: "timestamp desc",
      };
      const resp = await fetch("https://logging.googleapis.com/v2/entries:list", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) return [];
      const data = await resp.json() as { entries?: GCPLogEntry[] };
      return data.entries ?? [];
    };

    // Cloud Monitoring: Firestore usage metric for last 24h
    const fetchQuotaMetric = async (metricType: string): Promise<number> => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86400000);
      const params = new URLSearchParams({
        filter: `metric.type="${metricType}"`,
        "interval.startTime": yesterday.toISOString(),
        "interval.endTime": now.toISOString(),
        "aggregation.alignmentPeriod": "86400s",
        "aggregation.perSeriesAligner": "ALIGN_SUM",
      });
      const resp = await fetch(
        `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!resp.ok) return 0;
      const data = await resp.json() as {
        timeSeries?: { points?: { value?: { int64Value?: string; doubleValue?: number } }[] }[];
      };
      const point = data.timeSeries?.[0]?.points?.[0]?.value;
      if (!point) return 0;
      return point.int64Value ? parseInt(point.int64Value, 10) : Math.round(point.doubleValue ?? 0);
    };

    const [
      [fsResult, authResult, stripeResult],
      rawLogs,
      schedulerJobs,
      schedulerErrors,
      fsReads,
      fsWrites,
      rawCloudFunctions,
    ] = await Promise.all([
      Promise.allSettled([pingFirestore(), pingAuth(), pingStripe()]),
      fetchLogs().catch(() => [] as GCPLogEntry[]),
      fetchSchedulerJobs().catch(() => [] as SchedulerJob[]),
      fetchSchedulerErrors().catch(() => [] as GCPLogEntry[]),
      fetchQuotaMetric("firestore.googleapis.com/document/read_count").catch(() => 0),
      fetchQuotaMetric("firestore.googleapis.com/document/write_count").catch(() => 0),
      fetchCloudFunctions().catch(() => [] as CloudFunctionV2[]),
    ]);

    // Build service status
    const services = (
      [
        { result: fsResult, name: "Firestore" },
        { result: authResult, name: "Firebase Auth" },
        { result: stripeResult, name: "Stripe" },
      ] as { result: PromiseSettledResult<number>; name: string }[]
    ).map(({ result, name }) => {
      if (result.status === "rejected") {
        return { name, status: "outage" as const, latency: null as number | null, uptime: 0 };
      }
      const latency = result.value;
      return {
        name,
        status: latency > 1000 ? ("degraded" as const) : ("operational" as const),
        latency,
        uptime: latency > 1000 ? 98.5 : 99.9,
      };
    });

    // Deduplicate and structure logs
    const countMap = new Map<string, number>();
    const seenOrder: string[] = [];
    for (const entry of rawLogs) {
      const sev = entry.severity ?? "INFO";
      const msg = typeof entry.jsonPayload?.["message"] === "string"
        ? entry.jsonPayload["message"]
        : typeof entry.textPayload === "string"
        ? entry.textPayload
        : typeof entry.jsonPayload?.["msg"] === "string"
        ? (entry.jsonPayload["msg"] as string)
        : JSON.stringify(entry.jsonPayload ?? "").slice(0, 200);
      const fn = entry.resource?.labels?.["function_name"]
        ?? entry.resource?.labels?.["service_name"]
        ?? "unknown";
      const key = `${sev}::${fn}::${msg.slice(0, 80)}`;
      if (!countMap.has(key)) {
        seenOrder.push(key);
      }
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    }

    const entryByKey = new Map<string, GCPLogEntry>();
    for (const entry of rawLogs) {
      const sev = entry.severity ?? "INFO";
      const msg = typeof entry.jsonPayload?.["message"] === "string"
        ? entry.jsonPayload["message"]
        : typeof entry.textPayload === "string"
        ? entry.textPayload
        : typeof entry.jsonPayload?.["msg"] === "string"
        ? (entry.jsonPayload["msg"] as string)
        : JSON.stringify(entry.jsonPayload ?? "").slice(0, 200);
      const fn = entry.resource?.labels?.["function_name"]
        ?? entry.resource?.labels?.["service_name"]
        ?? "unknown";
      const key = `${sev}::${fn}::${msg.slice(0, 80)}`;
      if (!entryByKey.has(key)) {
        entryByKey.set(key, entry);
      }
    }

    const logs = seenOrder.map((key) => {
      const entry = entryByKey.get(key)!;
      const sev = entry.severity ?? "INFO";
      const level =
        sev === "ERROR" || sev === "CRITICAL" || sev === "ALERT" || sev === "EMERGENCY"
          ? ("error" as const)
          : sev === "WARNING"
          ? ("warn" as const)
          : ("info" as const);
      const msg = typeof entry.jsonPayload?.["message"] === "string"
        ? entry.jsonPayload["message"]
        : typeof entry.textPayload === "string"
        ? entry.textPayload
        : typeof entry.jsonPayload?.["msg"] === "string"
        ? (entry.jsonPayload["msg"] as string)
        : JSON.stringify(entry.jsonPayload ?? "").slice(0, 200);
      const fn = entry.resource?.labels?.["function_name"]
        ?? entry.resource?.labels?.["service_name"]
        ?? "unknown";
      const region = entry.resource?.labels?.["region"]
        ?? entry.resource?.labels?.["location"]
        ?? "us-central1";
      const trace = (entry.jsonPayload?.["stack_trace"] ?? entry.jsonPayload?.["stackTrace"]) as string | undefined;

      return {
        id: entry.insertId ?? entry.timestamp,
        level,
        msg: (msg as string).slice(0, 300),
        fn,
        region,
        ts: entry.timestamp,
        count: countMap.get(key) ?? 1,
        trace,
      };
    });

    // Build failed jobs list
    const schedulerErrorMap = new Map<string, GCPLogEntry>();
    for (const entry of schedulerErrors) {
      const jobId = entry.resource?.labels?.["job_id"] ?? "";
      if (jobId && !schedulerErrorMap.has(jobId)) {
        schedulerErrorMap.set(jobId, entry);
      }
    }

    const KNOWN_JOBS: Record<string, string> = {
      expireCredits: "0 2 * * *",
      autoCheckIn: "*/5 * * * *",
      retentionTriggers: "0 8 * * *",
      processAccountDeletions: "0 4 * * *",
    };

    const failedJobs = schedulerJobs
      .filter((job) => {
        const shortName = job.name.split("/").pop() ?? "";
        const stateFailed = job.state !== "ENABLED" && job.state !== "PAUSED";
        const hasError = schedulerErrorMap.has(shortName);
        return stateFailed || hasError;
      })
      .map((job) => {
        const shortName = job.name.split("/").pop() ?? job.name;
        const errorEntry = schedulerErrorMap.get(shortName);
        const reason = typeof errorEntry?.jsonPayload?.["message"] === "string"
          ? (errorEntry.jsonPayload["message"] as string)
          : typeof errorEntry?.textPayload === "string"
          ? errorEntry.textPayload
          : job.state !== "ENABLED"
          ? `Job is in state: ${job.state}`
          : "Execution failed";
        return {
          id: shortName,
          name: shortName,
          schedule: KNOWN_JOBS[shortName] ?? job.schedule ?? "",
          reason: reason.slice(0, 200),
          failed: errorEntry?.timestamp ?? job.lastAttemptTime ?? new Date().toISOString(),
          retries: 0,
          affected: 0,
        };
      });

    // Quota summary
    const quotas = [
      {
        name: "Firestore reads",
        used: fsReads,
        limit: 50000,
        unit: "reads/day",
        pct: Math.min(100, Math.round((fsReads / 50000) * 100)),
      },
      {
        name: "Firestore writes",
        used: fsWrites,
        limit: 20000,
        unit: "writes/day",
        pct: Math.min(100, Math.round((fsWrites / 20000) * 100)),
      },
    ];

    // Map deployed Cloud Functions
    const deployedFunctions = rawCloudFunctions
      .map((fn) => {
        const shortName = fn.name.split("/").pop() ?? fn.name;
        const state = fn.state ?? "UNKNOWN";
        const stateMsg = fn.stateMessages?.find((m) => m.severity === "ERROR")?.message ?? null;
        return {
          name: shortName,
          state,
          status: state === "ACTIVE" ? "active" as const : state === "FAILED" ? "failed" as const : "deploying" as const,
          runtime: fn.buildConfig?.runtime ?? null,
          memory: fn.serviceConfig?.availableMemory ?? null,
          timeout: fn.serviceConfig?.timeoutSeconds ?? null,
          updatedAt: fn.updateTime ?? null,
          errorMessage: stateMsg,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    sendJsonResponse(req, res, 200, { services, logs, failedJobs, quotas, deployedFunctions });
  } catch (error) {
    console.error("danceup-admin-health error:", error);
    handleError(req, res, error);
  }
});

export const danceupAdminHealth = functions.https.onRequest(app);
