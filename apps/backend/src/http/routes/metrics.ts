import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (_request, reply) => {
    const db = app.db.drizzle;
    if (!db) {
      reply.code(503);
      return "# metrics unavailable: drizzle database is not configured\n";
    }

    const metrics = await buildPrometheusMetrics(db);
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return metrics;
  });
}

type MetricsDb = NonNullable<FastifyInstance["db"]["drizzle"]>;

type JobCountRow = {
  readonly processor_id: string;
  readonly job_type: string;
  readonly status: string;
  readonly count: string | number;
};

type JobAgeRow = {
  readonly processor_id: string;
  readonly job_type: string;
  readonly status: string;
  readonly max_age_seconds: string | number | null;
};

type JobDurationRow = {
  readonly processor_id: string;
  readonly job_type: string;
  readonly status: string;
  readonly duration_seconds: string | number;
};

type JobWaitRow = {
  readonly processor_id: string;
  readonly job_type: string;
  readonly status: string;
  readonly wait_seconds: string | number;
};

type DocumentVersionStatusRow = {
  readonly status: string;
  readonly count: string | number;
};

const durationBucketsSeconds = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1200];

async function buildPrometheusMetrics(db: MetricsDb): Promise<string> {
  const [jobCounts, queueAges, runningAges, durations, waits, documentVersionCounts] =
    await Promise.all([
      db.execute<JobCountRow>(sql`
        select processor_id, job_type, status, count(*) as count
        from processing_jobs
        group by processor_id, job_type, status
        order by processor_id, job_type, status
      `),
      db.execute<JobAgeRow>(sql`
        select
          processor_id,
          job_type,
          status,
          max(extract(epoch from now() - coalesce(next_run_at, scheduled_at, created_at))) as max_age_seconds
        from processing_jobs
        where status in ('pending', 'queued')
        group by processor_id, job_type, status
        order by processor_id, job_type, status
      `),
      db.execute<JobAgeRow>(sql`
        select
          processor_id,
          job_type,
          status,
          max(extract(epoch from now() - coalesce(started_at, updated_at, created_at))) as max_age_seconds
        from processing_jobs
        where status = 'running'
        group by processor_id, job_type, status
        order by processor_id, job_type, status
      `),
      db.execute<JobDurationRow>(sql`
        select
          processor_id,
          job_type,
          status,
          extract(epoch from (coalesce(completed_at, updated_at) - started_at)) as duration_seconds
        from processing_jobs
        where started_at is not null
          and coalesce(completed_at, updated_at) >= started_at
          and status in ('completed', 'failed')
      `),
      db.execute<JobWaitRow>(sql`
        select
          processor_id,
          job_type,
          status,
          extract(epoch from (started_at - created_at)) as wait_seconds
        from processing_jobs
        where started_at is not null
          and started_at >= created_at
      `),
      db.execute<DocumentVersionStatusRow>(sql`
        select status, count(*) as count
        from document_versions
        group by status
        order by status
      `)
    ]);

  const lines: string[] = [
    "# HELP vai_processing_jobs_total Processing jobs grouped by processor, job type, and status.",
    "# TYPE vai_processing_jobs_total gauge"
  ];
  for (const row of jobCounts.rows) {
    lines.push(
      metricLine("vai_processing_jobs_total", jobLabels(row), toNumber(row.count))
    );
  }

  lines.push(
    "# HELP vai_processing_queue_oldest_age_seconds Oldest pending or queued job age.",
    "# TYPE vai_processing_queue_oldest_age_seconds gauge"
  );
  for (const row of queueAges.rows) {
    lines.push(
      metricLine(
        "vai_processing_queue_oldest_age_seconds",
        jobLabels(row),
        toNumber(row.max_age_seconds ?? 0)
      )
    );
  }

  lines.push(
    "# HELP vai_processing_running_oldest_age_seconds Oldest currently running job age.",
    "# TYPE vai_processing_running_oldest_age_seconds gauge"
  );
  for (const row of runningAges.rows) {
    lines.push(
      metricLine(
        "vai_processing_running_oldest_age_seconds",
        jobLabels(row),
        toNumber(row.max_age_seconds ?? 0)
      )
    );
  }

  lines.push(
    "# HELP vai_processing_job_duration_seconds Completed or failed processing job runtime.",
    "# TYPE vai_processing_job_duration_seconds histogram",
    ...histogramLines({
      metricName: "vai_processing_job_duration_seconds",
      rows: durations.rows,
      readValue: (row) => row.duration_seconds
    })
  );

  lines.push(
    "# HELP vai_processing_job_wait_seconds Processing job wait time before it was claimed.",
    "# TYPE vai_processing_job_wait_seconds histogram",
    ...histogramLines({
      metricName: "vai_processing_job_wait_seconds",
      rows: waits.rows,
      readValue: (row) => row.wait_seconds
    })
  );

  lines.push(
    "# HELP vai_document_versions_total Document versions grouped by status.",
    "# TYPE vai_document_versions_total gauge"
  );
  for (const row of documentVersionCounts.rows) {
    lines.push(
      metricLine(
        "vai_document_versions_total",
        { status: row.status },
        toNumber(row.count)
      )
    );
  }

  return `${lines.join("\n")}\n`;
}

function histogramLines<TRow extends {
  readonly processor_id: string;
  readonly job_type: string;
  readonly status: string;
}>(input: {
  readonly metricName: string;
  readonly rows: readonly TRow[];
  readonly readValue: (row: TRow) => string | number;
}): string[] {
  const groups = new Map<string, { labels: Record<string, string>; values: number[] }>();
  for (const row of input.rows) {
    const labels = jobLabels(row);
    const key = JSON.stringify(labels);
    const group = groups.get(key) ?? { labels, values: [] };
    group.values.push(toNumber(input.readValue(row)));
    groups.set(key, group);
  }

  const lines: string[] = [];
  for (const group of groups.values()) {
    const sorted = group.values.filter(Number.isFinite).sort((left, right) => left - right);
    for (const bucket of durationBucketsSeconds) {
      lines.push(
        metricLine(
          `${input.metricName}_bucket`,
          { ...group.labels, le: String(bucket) },
          sorted.filter((value) => value <= bucket).length
        )
      );
    }
    lines.push(
      metricLine(
        `${input.metricName}_bucket`,
        { ...group.labels, le: "+Inf" },
        sorted.length
      ),
      metricLine(`${input.metricName}_count`, group.labels, sorted.length),
      metricLine(
        `${input.metricName}_sum`,
        group.labels,
        sorted.reduce((sum, value) => sum + value, 0)
      )
    );
  }
  return lines;
}

function jobLabels(row: {
  readonly processor_id: string;
  readonly job_type: string;
  readonly status: string;
}): Record<string, string> {
  return {
    processor_id: row.processor_id,
    job_type: row.job_type,
    status: row.status
  };
}

function metricLine(name: string, labels: Record<string, string>, value: number): string {
  const labelText = Object.entries(labels)
    .map(([key, labelValue]) => `${key}="${escapeLabel(labelValue)}"`)
    .join(",");
  return `${name}{${labelText}} ${formatMetricValue(value)}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}

function formatMetricValue(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0";
}

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}
