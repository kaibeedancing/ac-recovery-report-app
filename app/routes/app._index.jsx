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

function getISOWeekInfo(date) {
  const tmp = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );

  const dayNum = tmp.getUTCDay() || 7;

  // Move to the Thursday of the current ISO week.
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);

  const isoYear = tmp.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));

  const week = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);

  return {
    isoYear,
    week,
  };
}

function getBucketKey(date, bucketType) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  if (bucketType === "year") {
    return String(year);
  }

  if (bucketType === "month") {
    return `${year}-${month}`;
  }

  if (bucketType === "week") {
    const { isoYear, week } = getISOWeekInfo(date);

    return `${isoYear}-W${String(week).padStart(2, "0")}`;
  }

  return `${year}-${month}-${day}`;
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

  if (Array.isArray(tagsRaw)) {
    return tagsRaw;
  }

  if (typeof tagsRaw === "string") {
    return tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  return [];
}

function parsePartialRcTag(partialRcTag) {
  // Expected format:
  // PRC<id>R<recovered value>V<total value>
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
  // Expected format:
  // FRC<checkout_id>R<value>
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
  tag,
  startDate,
  endDate,
  bucketType,
}) {
  const exclusiveEnd = addDaysISO(endDate, 1);
  const searchQuery = `tag:${tag} created_at:>=${startDate} created_at:<${exclusiveEnd}`;

  // bucketKey -> {
  //   bucket: string,
  //   revenue: number,
  //   orderCount: number,
  //   orderNumbers: string[]
  // }
  const seriesMap = new Map();

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
              name
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
      variables: {
        first: 50,
        after: cursor,
        q: searchQuery,
      },
    });

    const data = await response.json();
    const connection = data?.data?.orders;

    if (!connection) {
      break;
    }

    for (const edge of connection.edges) {
      const node = edge.node;
      const tags = normalizeShopifyTags(node.tags);

      const fullFrcTag = tags.find(
        (t) =>
          typeof t === "string" &&
          t.startsWith("FRC")
      );

      const fullRecoTag = tags.find(
        (t) =>
          typeof t === "string" &&
          t.startsWith("Full-AC-Revenue-Recovery")
      );

      // The order must have both tags to contribute to recovered revenue.
      if (!fullFrcTag) continue;
      if (!fullRecoTag) continue;

      const parsed = parseFullFrcTag(fullFrcTag);

      const safeFrcValue =
        parsed && Number.isFinite(parsed.value)
          ? parsed.value
          : 0;

      const createdAt = new Date(node.createdAt);
      const bucketKey = getBucketKey(createdAt, bucketType);

      if (!seriesMap.has(bucketKey)) {
        seriesMap.set(bucketKey, {
          bucket: bucketKey,
          revenue: 0,
          orderCount: 0,
          orderNumbers: [],
        });
      }

      const entry = seriesMap.get(bucketKey);

      entry.revenue += safeFrcValue;
      entry.orderCount += 1;

      if (node.name) {
        entry.orderNumbers.push(node.name);
      }
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  const series = [...seriesMap.values()].sort((a, b) =>
    a.bucket.localeCompare(b.bucket)
  );

  const totalRevenue = series.reduce(
    (sum, point) => sum + (point.revenue || 0),
    0
  );

  const ordersReturned = series.reduce(
    (count, point) => count + (point.orderCount || 0),
    0
  );

  return {
    series,
    totalRevenue,
    ordersReturned,
  };
}

async function fetchPartialSeriesByTag({
  admin,
  tag,
  startDate,
  endDate,
  bucketType,
}) {
  const exclusiveEnd = addDaysISO(endDate, 1);
  const searchQuery = `tag:${tag} created_at:>=${startDate} created_at:<${exclusiveEnd}`;

  // bucketKey -> {
  //   bucket: string,
  //   revenue: number,
  //   orderCount: number,
  //   orderNumbers: string[]
  // }
  const seriesMap = new Map();

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
              name
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
      variables: {
        first: 50,
        after: cursor,
        q: searchQuery,
      },
    });

    const data = await response.json();
    const connection = data?.data?.orders;

    if (!connection) {
      break;
    }

    for (const edge of connection.edges) {
      const node = edge.node;
      const orderTags = normalizeShopifyTags(node.tags);

      const partialRcTag = orderTags.find(
        (t) =>
          typeof t === "string" &&
          t.startsWith("PRC")
      );

      if (!partialRcTag) {
        continue;
      }

      const customerTags = normalizeShopifyTags(node.customer?.tags);
      const customerHasSameTag = customerTags.includes(partialRcTag);

      if (!customerHasSameTag) {
        continue;
      }

      const parsed = parsePartialRcTag(partialRcTag);

      if (!parsed) {
        continue;
      }

      const safePartialRevenue = Number.isFinite(parsed.rValue)
        ? parsed.rValue
        : 0;

      const createdAt = new Date(node.createdAt);
      const bucketKey = getBucketKey(createdAt, bucketType);

      if (!seriesMap.has(bucketKey)) {
        seriesMap.set(bucketKey, {
          bucket: bucketKey,
          revenue: 0,
          orderCount: 0,
          orderNumbers: [],
        });
      }

      const entry = seriesMap.get(bucketKey);

      entry.revenue += safePartialRevenue;
      entry.orderCount += 1;

      if (node.name) {
        entry.orderNumbers.push(node.name);
      }
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  const series = [...seriesMap.values()].sort((a, b) =>
    a.bucket.localeCompare(b.bucket)
  );

  const totalRevenue = series.reduce(
    (sum, point) => sum + (point.revenue || 0),
    0
  );

  const ordersReturned = series.reduce(
    (count, point) => count + (point.orderCount || 0),
    0
  );

  return {
    series,
    totalRevenue,
    ordersReturned,
  };
}

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  let startDate = formData.get("startDate");
  let endDate = formData.get("endDate");

  const bucket = formData.get("bucket");
  const exportMode = formData.get("exportMode");
  const view = formData.get("view");

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

  const recovered = await fetchSeriesByTag({
    admin,
    tag: FULL_TAG_NAME,
    startDate,
    endDate,
    bucketType,
  });

  const partial = await fetchPartialSeriesByTag({
    admin,
    tag: PARTIAL_TAG_NAME,
    startDate,
    endDate,
    bucketType,
  });

  const seriesBoth = (() => {
    const map = new Map();

    for (const point of recovered.series) {
      map.set(point.bucket, {
        bucket: point.bucket,

        recoveredRevenue: Number(point.revenue || 0),
        partialRevenue: 0,

        recoveredOrderCount: Number(point.orderCount || 0),
        partialOrderCount: 0,

        recoveredOrderNumbers: Array.isArray(point.orderNumbers)
          ? point.orderNumbers
          : [],

        partialOrderNumbers: [],
      });
    }

    for (const point of partial.series) {
      if (!map.has(point.bucket)) {
        map.set(point.bucket, {
          bucket: point.bucket,

          recoveredRevenue: 0,
          partialRevenue: Number(point.revenue || 0),

          recoveredOrderCount: 0,
          partialOrderCount: Number(point.orderCount || 0),

          recoveredOrderNumbers: [],
          partialOrderNumbers: Array.isArray(point.orderNumbers)
            ? point.orderNumbers
            : [],
        });
      } else {
        const row = map.get(point.bucket);

        row.partialRevenue = Number(point.revenue || 0);
        row.partialOrderCount = Number(point.orderCount || 0);

        row.partialOrderNumbers = Array.isArray(point.orderNumbers)
          ? point.orderNumbers
          : [];
      }
    }

    return [...map.values()].sort((a, b) =>
      a.bucket.localeCompare(b.bucket)
    );
  })();

  const selectedView =
    view === "partial" || view === "both"
      ? view
      : "recovered";

  let payloadSeries = [];
  let summary = null;

  if (selectedView === "recovered") {
    payloadSeries = recovered.series.map((point) => ({
      ...point,
      revenue: Number(point.revenue ?? 0),
      orderCount: Number(point.orderCount ?? 0),
      orderNumbers: Array.isArray(point.orderNumbers)
        ? point.orderNumbers
        : [],
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
    payloadSeries = partial.series.map((point) => ({
      ...point,
      revenue: Number(point.revenue ?? 0),
      orderCount: Number(point.orderCount ?? 0),
      orderNumbers: Array.isArray(point.orderNumbers)
        ? point.orderNumbers
        : [],
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
      const payloadForCsv = payloadSeries.map((point) => ({
        ...point,

        recoveredOrderNumbers: Array.isArray(
          point.recoveredOrderNumbers
        )
          ? point.recoveredOrderNumbers.join(" ")
          : "",

        partialOrderNumbers: Array.isArray(
          point.partialOrderNumbers
        )
          ? point.partialOrderNumbers.join(" ")
          : "",
      }));

      const csv = buildCSV(payloadForCsv, [
        "bucket",
        "recoveredRevenue",
        "recoveredOrderCount",
        "recoveredOrderNumbers",
        "partialRevenue",
        "partialOrderCount",
        "partialOrderNumbers",
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
    }

    const payloadForCsv = payloadSeries.map((point) => ({
      ...point,

      orderNumbers: Array.isArray(point.orderNumbers)
        ? point.orderNumbers.join(" ")
        : "",
    }));

    const csv = buildCSV(payloadForCsv, [
      "bucket",
      "revenue",
      "orderCount",
      "orderNumbers",
    ]);

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

  return {
    summary,
    series: payloadSeries,
  };
};

function RevenueChart({ series, view }) {
  if (!Array.isArray(series) || series.length === 0) {
    return null;
  }

  const normalized = series.map((point) => {
    if (view === "both") {
      return {
        ...point,
        recoveredRevenue: Number(point.recoveredRevenue ?? 0),
        partialRevenue: Number(point.partialRevenue ?? 0),
      };
    }

    return {
      ...point,
      revenue: Number(point.revenue ?? 0),
    };
  });

  const money2 = (value) => {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return "$0.00";
    }

    return `$${number.toFixed(2)}`;
  };

  return (
    <div style={{ width: "100%", height: 360 }}>
      <ResponsiveContainer>
        <LineChart
          data={normalized}
          margin={{
            top: 12,
            right: 16,
            left: 0,
            bottom: 0,
          }}
        >
          <CartesianGrid strokeDasharray="3 3" />

          <XAxis
            dataKey="bucket"
            minTickGap={20}
          />

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
              name={
                view === "partial"
                  ? "Partial RC Value"
                  : "Full RC Value"
              }
              stroke={
                view === "partial"
                  ? "#ff6b6b"
                  : "#5c6ac4"
              }
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
  const [view, setView] = useState("recovered");

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (startDate && endDate) {
      return;
    }

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

    fetcher.submit(payload, {
      method: "POST",
    });
  };

  useEffect(() => {
    if (!startDate || !endDate) {
      return;
    }

    submitReport();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, bucket, view]);

  useEffect(() => {
    const exp = fetcher.data?.export;

    if (!exp?.csv) {
      return;
    }

    downloadTextFile(
      exp.filename,
      exp.mime || "text/csv;charset=utf-8;",
      exp.csv
    );

    shopify.toast.show("CSV exported");
  }, [fetcher.data?.export, shopify]);

  const exportCSV = () => {
    submitReport({
      exportMode: "csv",
    });
  };

  const summary = fetcher.data?.summary;
  const series = fetcher.data?.series;

  const money2 = (value) => {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return "$0.00";
    }

    return `$${number.toFixed(2)}`;
  };

  const chartSeries = useMemo(() => {
    if (!Array.isArray(series)) {
      return [];
    }

    if (view === "both") {
      return series.map((point) => ({
        ...point,
        recoveredRevenue: Number(point.recoveredRevenue ?? 0),
        partialRevenue: Number(point.partialRevenue ?? 0),
        recoveredOrderCount: Number(
          point.recoveredOrderCount ?? 0
        ),
        partialOrderCount: Number(
          point.partialOrderCount ?? 0
        ),
      }));
    }

    return series.map((point) => ({
      ...point,
      revenue: Number(point.revenue ?? 0),
      orderCount: Number(point.orderCount ?? 0),
    }));
  }, [series, view]);

  return (
    <s-page heading="RC Value Revenue Report">
      <s-stack direction="block" gap="base">
        <s-section heading="Filters">
          <s-stack
            direction="inline"
            gap="base"
            wrap
          >
            <label>
              Start date

              <input
                type="date"
                value={startDate}
                onChange={(event) =>
                  setStartDate(event.target.value)
                }
              />
            </label>

            <label>
              End date

              <input
                type="date"
                value={endDate}
                onChange={(event) =>
                  setEndDate(event.target.value)
                }
              />
            </label>

            <label>
              Bucket

              <select
                value={bucket}
                onChange={(event) =>
                  setBucket(event.target.value)
                }
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
                <option value="year">Year</option>
              </select>
            </label>

            <label>
              View

              <select
                value={view}
                onChange={(event) =>
                  setView(event.target.value)
                }
              >
                <option value="recovered">Recovered</option>
                <option value="partial">Partial</option>
                <option value="both">Both</option>
              </select>
            </label>

            <s-button
              variant="tertiary"
              onClick={exportCSV}
              disabled={
                isLoading ||
                !Array.isArray(series) ||
                series.length === 0
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

                  <s-paragraph>
                    Orders in range: {summary.ordersReturned}
                  </s-paragraph>

                  <s-paragraph>
                    Range: {summary.startDate} → {summary.endDate}{" "}
                    (bucket: {summary.bucket})
                  </s-paragraph>
                </>
              ) : (
                <>
                  <s-paragraph>
                    Recovered total:{" "}
                    {money2(summary.recoveredTotalRevenue)}{" "}
                    (orders: {summary.recoveredOrdersReturned})
                  </s-paragraph>

                  <s-paragraph>
                    Partial total:{" "}
                    {money2(summary.partialTotalRevenue)}{" "}
                    (orders: {summary.partialOrdersReturned})
                  </s-paragraph>

                  <s-paragraph>
                    Range: {summary.startDate} → {summary.endDate}{" "}
                    (bucket: {summary.bucket})
                  </s-paragraph>
                </>
              )}
            </s-box>
          </s-section>
        )}

        {Array.isArray(chartSeries) &&
          chartSeries.length > 0 && (
            <s-section heading="Revenue over time">
              <RevenueChart
                series={chartSeries}
                view={view}
              />
            </s-section>
          )}

        {Array.isArray(chartSeries) &&
          chartSeries.length === 0 && (
            <s-section heading="Revenue over time">
              <s-paragraph>
                No matching orders found for the selected range.
              </s-paragraph>
            </s-section>
          )}
      </s-stack>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};