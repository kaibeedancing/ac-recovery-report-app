import React, { useMemo, useState, useEffect } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

function getISOWeek(date) {
  const tmp = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return weekNo;
}

function toISODateUTCString(d) {
  return d.toISOString().slice(0, 10);
}

function addDaysISO(yyyyMmDd, daysToAdd) {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return d.toISOString().slice(0, 10);
}

function buildCSV(rows, headers) {
  const escape = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };

  const headerLine = headers.map(escape).join(",");
  const lines = rows.map((row) =>
    headers.map((h) => escape(row?.[h])).join(",")
  );
  return [headerLine, ...lines].join("\n");
}

function downloadTextFile(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function normalizeShopifyTags(tagsRaw) {
  if (!tagsRaw) return [];
  if (Array.isArray(tagsRaw)) return tagsRaw;
  if (typeof tagsRaw === "string") {
    return tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

function parsePartialRcTag(partialRcTag) {
  // Expected format: "PRC<id>R<recovered value>V<total value>"
  const re = /^PRC(.+?)R([+-]?\d+(?:\.\d+)?)V([+-]?\d+(?:\.\d+)?)$/;

  const m = String(partialRcTag).match(re);
  if (!m) return null;

  return {
    abandonedCheckoutId: m[1].trim(),
    rValue: Number(m[2]),
    vValue: Number(m[3]),
  };
}

function parseFullFrcTag(fullFrcTag) {
  // Expected format: "FRC<checkout_id>R<value>"
  // Extract R as the revenue value.
  const re = /^FRC(.+?)R([+-]?\d+(?:\.\d+)?)$/;
  const m = String(fullFrcTag).match(re);
  if (!m) return null;

  return {
    abandonedCheckoutId: m[1].trim(),
    value: Number(m[2]),
  };
}

async function fetchSeriesByTag({
  admin,
  tag, // tag name without "tag:" prefix
  startDate,
  endDate,
  bucketType,
}) {
  const exclusiveEnd = addDaysISO(endDate, 1);
  const searchQuery = `tag:${tag} created_at:>=${startDate} created_at:<${exclusiveEnd}`;

  const seriesMap = new Map(); // bucketKey -> { bucket, revenue: number, orderCount: number }

  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const query = `
      query OrdersByTagAndDate($first: Int!, $after: String, $q: String!) {
        orders(first: $first, after: $after, query: $q) {
          edges {
            cursor
            node {
              id
              createdAt
              tags
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const response = await admin.graphql(`#graphql\n${query}`, {
      variables: { first: 50, after: cursor, q: searchQuery },
    });

    const data = await response.json();
    const connection = data?.data?.orders;
    if (!connection) break;

    for (const edge of connection.edges) {
      const node = edge.node;

      const tags = normalizeShopifyTags(node.tags);

      // Find the "FRC<checkout_id>R<value>" tag on the ORDER
      const fullFrcTag = tags.find(
        (t) => typeof t === "string" && t.startsWith("FRC")
      );


      //Find the "Full-AC-Revenue-Recovery" tag
      const fullRecoTag = tags.find(
        (t) => typeof t === "string" && t.startsWith("Full-AC-Revenue-Recovery")
      );

      // If the order doesn't have the FRC or Full-AC-Revenue-Recovery tag, it doesn't contribute to revenue
      if (!fullFrcTag) continue;
      if (!fullRecoTag) continue;

      const parsed = parseFullFrcTag(fullFrcTag);
      const safeFrcValue =
        parsed && Number.isFinite(parsed.value) ? parsed.value : 0;

      const createdAt = new Date(node.createdAt);

      let bucketKey;
      if (bucketType === "week") {
        const year = createdAt.getUTCFullYear();
        const week = getISOWeek(createdAt);
        bucketKey = `${year}-W${String(week).padStart(2, "0")}`;
      } else {
        bucketKey = createdAt.toISOString().slice(0, 10);
      }

      if (!seriesMap.has(bucketKey)) {
        seriesMap.set(bucketKey, {
          bucket: bucketKey,
          revenue: 0,
          orderCount: 0,
        });
      }

      const entry = seriesMap.get(bucketKey);
      entry.revenue += safeFrcValue;
      entry.orderCount += 1;
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  const series = [...seriesMap.values()].sort((a, b) =>
    a.bucket.localeCompare(b.bucket)
  );

  const totalRevenue = series.reduce((sum, p) => sum + (p.revenue || 0), 0);
  const ordersReturned = series.reduce(
    (n, p) => n + (p.orderCount || 0),
    0
  );

  return { series, totalRevenue, ordersReturned };
}

async function fetchPartialSeriesByTag({
  admin,
  tag, // tag name without "tag:" prefix (the existing PARTIAL_TAG_NAME)
  startDate,
  endDate,
  bucketType,
}) {
  const exclusiveEnd = addDaysISO(endDate, 1);
  const searchQuery = `tag:${tag} created_at:>=${startDate} created_at:<${exclusiveEnd}`;

  const seriesMap = new Map(); // bucketKey -> { bucket, revenue: number, orderCount: number }

  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const query = `
      query OrdersByTagAndDate($first: Int!, $after: String, $q: String!) {
        orders(first: $first, after: $after, query: $q) {
          edges {
            cursor
            node {
              id
              createdAt
              tags
              customer {
                id
                tags
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const response = await admin.graphql(`#graphql\n${query}`, {
      variables: { first: 50, after: cursor, q: searchQuery },
    });

    const data = await response.json();
    const connection = data?.data?.orders;
    if (!connection) break;

    for (const edge of connection.edges) {
      const node = edge.node;

      const orderTags = normalizeShopifyTags(node.tags);

      // Find the "PRC<id>R<value>V<value>" tag on the ORDER
      const partialRcTag = orderTags.find(
        (t) => typeof t === "string" && t.startsWith("PRC")
      );

      // If the order doesn't have the PRC tag, it doesn't count
      if (!partialRcTag) continue;

      // Customer must have the *exact same tag string* as the order tag
      const customerTags = normalizeShopifyTags(node.customer?.tags);
      const customerHasSameTag = customerTags.includes(partialRcTag);
      if (!customerHasSameTag) continue;

      // Extract R: value from the tag
      const parsed = parsePartialRcTag(partialRcTag);
      if (!parsed) continue;

      const safePartialRevenue = Number.isFinite(parsed.rValue)
        ? parsed.rValue
        : 0;

      const createdAt = new Date(node.createdAt);

      let bucketKey;
      if (bucketType === "week") {
        const year = createdAt.getUTCFullYear();
        const week = getISOWeek(createdAt);
        bucketKey = `${year}-W${String(week).padStart(2, "0")}`;
      } else {
        bucketKey = createdAt.toISOString().slice(0, 10);
      }

      if (!seriesMap.has(bucketKey)) {
        seriesMap.set(bucketKey, {
          bucket: bucketKey,
          revenue: 0,
          orderCount: 0,
        });
      }

      const entry = seriesMap.get(bucketKey);
      entry.revenue += safePartialRevenue;
      entry.orderCount += 1;
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  const series = [...seriesMap.values()].sort((a, b) =>
    a.bucket.localeCompare(b.bucket)
  );

  const totalRevenue = series.reduce((sum, p) => sum + (p.revenue || 0), 0);
  const ordersReturned = series.reduce(
    (n, p) => n + (p.orderCount || 0),
    0
  );

  return { series, totalRevenue, ordersReturned };
}

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();

  let startDate = formData.get("startDate");
  let endDate = formData.get("endDate");
  const bucket = formData.get("bucket"); // "day" | "week"
  const exportMode = formData.get("exportMode"); // "csv" | null
  const view = formData.get("view"); // "recovered" | "partial" | "both"

  const FULL_TAG_NAME = "Full-AC-Revenue-Recovery";
  const PARTIAL_TAG_NAME = "Partial-AC-Revenue-Recovery";

  if (!startDate) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 90);
    startDate = toISODateUTCString(d);
  }
  if (!endDate) {
    const d = new Date();
    endDate = toISODateUTCString(d);
  }

  const bucketType =
    bucket === "week"
      ? "week"
      : bucket === "month"
      ? "month"
      : bucket === "year"
      ? "year"
      : "day";

  // Full/recovered now uses tag string format "FRC<id>V<value>"
  const recovered = await fetchSeriesByTag({
    admin,
    tag: FULL_TAG_NAME,
    startDate,
    endDate,
    bucketType,
  });

  // Partial uses:
  // - order tag: "PRC<id>R<value>V<value>"
  // - customer tags must contain the exact same tag string
  const partial = await fetchPartialSeriesByTag({
    admin,
    tag: PARTIAL_TAG_NAME,
    startDate,
    endDate,
    bucketType,
  });

  const seriesBoth = (() => {
    const map = new Map();

    for (const p of recovered.series) {
      map.set(p.bucket, {
        bucket: p.bucket,
        recoveredRevenue: Number(p.revenue || 0),
        partialRevenue: 0,
        recoveredOrderCount: Number(p.orderCount || 0),
        partialOrderCount: 0,
      });
    }

    for (const p of partial.series) {
      if (!map.has(p.bucket)) {
        map.set(p.bucket, {
          bucket: p.bucket,
          recoveredRevenue: 0,
          partialRevenue: Number(p.revenue || 0),
          recoveredOrderCount: 0,
          partialOrderCount: Number(p.orderCount || 0),
        });
      } else {
        const row = map.get(p.bucket);
        row.partialRevenue = Number(p.revenue || 0);
        row.partialOrderCount = Number(p.orderCount || 0);
      }
    }

    return [...map.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  })();

  const selectedView =
    view === "partial" || view === "both" ? view : "recovered";

  let payloadSeries = [];
  let summary = null;

  if (selectedView === "recovered") {
    payloadSeries = recovered.series.map((p) => ({
      ...p,
      revenue: Number(p.revenue ?? 0),
      orderCount: Number(p.orderCount ?? 0),
    }));
    summary = {
      startDate,
      endDate,
      bucket: bucketType,
      view: "Recovered",
      totalRevenue: recovered.totalRevenue,
      ordersReturned: recovered.ordersReturned,
    };
  } else if (selectedView === "partial") {
    payloadSeries = partial.series.map((p) => ({
      ...p,
      revenue: Number(p.revenue ?? 0),
      orderCount: Number(p.orderCount ?? 0),
    }));
    summary = {
      startDate,
      endDate,
      bucket: bucketType,
      view: "Partial",
      totalRevenue: partial.totalRevenue,
      ordersReturned: partial.ordersReturned,
    };
  } else {
    payloadSeries = seriesBoth;
    summary = {
      startDate,
      endDate,
      bucket: bucketType,
      view: "Both",
      recoveredTotalRevenue: recovered.totalRevenue,
      partialTotalRevenue: partial.totalRevenue,
      recoveredOrdersReturned: recovered.ordersReturned,
      partialOrdersReturned: partial.ordersReturned,
    };
  }

  if (exportMode === "csv") {
    if (selectedView === "both") {
      const csv = buildCSV(payloadSeries, [
        "bucket",
        "recoveredRevenue",
        "recoveredOrderCount",
        "partialRevenue",
        "partialOrderCount",
      ]);
      return {
        export: {
          format: "csv",
          filename: `rc-value-report_both_${startDate}_to_${endDate}_${bucketType}.csv`,
          mime: "text/csv;charset=utf-8;",
          csv,
        },
        summary,
      };
    } else {
      const csv = buildCSV(payloadSeries, ["bucket", "revenue", "orderCount"]);
      const filename = `rc-value-report_${selectedView}_${startDate}_to_${endDate}_${bucketType}.csv`;
      return {
        export: {
          format: "csv",
          filename,
          mime: "text/csv;charset=utf-8;",
          csv,
        },
        summary,
      };
    }
  }

  return { summary, series: payloadSeries };
};

function RevenueChart({ series, view }) {
  if (!Array.isArray(series) || series.length === 0) return null;

  const normalized = series.map((p) => {
    if (view === "both") {
      return {
        ...p,
        recoveredRevenue: Number(p.recoveredRevenue ?? 0),
        partialRevenue: Number(p.partialRevenue ?? 0),
      };
    }
    return {
      ...p,
      revenue: Number(p.revenue ?? 0),
    };
  });

  const money2 = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "$0.00";
    return `$${n.toFixed(2)}`;
  };

  return (
    <div style={{ width: "100%", height: 360 }}>
      <ResponsiveContainer>
        <LineChart
          data={normalized}
          margin={{ top: 12, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="bucket" minTickGap={20} />
          <YAxis tickFormatter={money2} />
          <Tooltip formatter={(value) => money2(value)} />
          <Legend />
          {view === "both" ? (
            <>
              <Line
                type="monotone"
                dataKey="recoveredRevenue"
                name="Full RC Value"
                stroke="#5c6ac4"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="partialRevenue"
                name="Partial RC Value"
                stroke="#ff6b6b"
                strokeWidth={2}
                dot={false}
              />
            </>
          ) : (
            <Line
              type="monotone"
              dataKey="revenue"
              name={view === "partial" ? "Partial RC Value" : "Full RC Value"}
              stroke={view === "partial" ? "#ff6b6b" : "#5c6ac4"}
              strokeWidth={2}
              dot={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function Index() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [bucket, setBucket] = useState("day");
  const [view, setView] = useState("recovered"); // recovered | partial | both

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (startDate && endDate) return;

    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - 90);
    const start = d.toISOString().slice(0, 10);

    setStartDate(start);
    setEndDate(end);
  }, [startDate, endDate]);

  const submitReport = (override = {}) => {
    const payload = {
      startDate,
      endDate,
      bucket,
      view,
      ...override,
    };

    fetcher.submit(payload, { method: "POST" });
  };

  useEffect(() => {
    if (!startDate || !endDate) return;
    submitReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, bucket, view]);

  useEffect(() => {
    const exp = fetcher.data?.export;
    if (!exp?.csv) return;

    downloadTextFile(exp.filename, exp.mime || "text/csv;charset=utf-8;", exp.csv);
    shopify.toast.show("CSV exported");
  }, [fetcher.data?.export, shopify]);

  const exportCSV = () => {
    submitReport({ exportMode: "csv" });
  };

  const summary = fetcher.data?.summary;
  const series = fetcher.data?.series;

  const money2 = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "$0.00";
    return `$${n.toFixed(2)}`;
  };

  const chartSeries = useMemo(() => {
    if (!Array.isArray(series)) return [];
    if (view === "both") {
      return series.map((p) => ({
        ...p,
        recoveredRevenue: Number(p.recoveredRevenue ?? 0),
        partialRevenue: Number(p.partialRevenue ?? 0),
        recoveredOrderCount: Number(p.recoveredOrderCount ?? 0),
        partialOrderCount: Number(p.partialOrderCount ?? 0),
      }));
    }
    return series.map((p) => ({
      ...p,
      revenue: Number(p.revenue ?? 0),
      orderCount: Number(p.orderCount ?? 0),
    }));
  }, [series, view]);

  return (
    <s-page heading="RC Value Revenue Report">
      <s-stack direction="block" gap="base">
        <s-section heading="Filters">
          <s-stack direction="inline" gap="base" wrap>
            <label>
              Start date
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </label>

            <label>
              End date
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </label>

            <label>
              Bucket
              <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
                <option value="year">Year</option>
              </select>
            </label>

            <label>
              View
              <select value={view} onChange={(e) => setView(e.target.value)}>
                <option value="recovered">Recovered</option>
                <option value="partial">Partial</option>
                <option value="both">Both</option>
              </select>
            </label>

            <s-button
              variant="tertiary"
              onClick={exportCSV}
              disabled={
                isLoading || !Array.isArray(series) || series.length === 0
              }
            >
              Export CSV
            </s-button>
          </s-stack>
        </s-section>

        {summary && (
          <s-section heading="Summary">
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              {summary.view !== "Both" ? (
                <>
                  <s-paragraph>
                    Total RC Value revenue ({summary.view}):{" "}
                    {money2(summary.totalRevenue)}
                  </s-paragraph>
                  <s-paragraph>Orders in range: {summary.ordersReturned}</s-paragraph>
                  <s-paragraph>
                    Range: {summary.startDate} → {summary.endDate} (bucket: {summary.bucket})
                  </s-paragraph>
                </>
              ) : (
                <>
                  <s-paragraph>
                    Recovered total: {money2(summary.recoveredTotalRevenue)} (orders: {summary.recoveredOrdersReturned})
                  </s-paragraph>
                  <s-paragraph>
                    Partial total: {money2(summary.partialTotalRevenue)} (orders: {summary.partialOrdersReturned})
                  </s-paragraph>
                  <s-paragraph>
                    Range: {summary.startDate} → {summary.endDate} (bucket: {summary.bucket})
                  </s-paragraph>
                </>
              )}
            </s-box>
          </s-section>
        )}

        {Array.isArray(chartSeries) && chartSeries.length > 0 && (
          <s-section heading="Revenue over time">
            <RevenueChart series={chartSeries} view={view} />
          </s-section>
        )}

        {Array.isArray(chartSeries) && chartSeries.length === 0 && (
          <s-section heading="Revenue over time">
            <s-paragraph>No matching orders found for the selected range.</s-paragraph>
          </s-section>
        )}
      </s-stack>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};