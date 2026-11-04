import React from "react";
import { useFetcher } from "react-router";

import { authenticate } from "../shopify.server";

const HARDCODED_PASSWORD = "TEST-TAG-CLEANUP";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  return null;
};

export async function action({ request }) {
  const form = await request.formData();
  const intent = form.get("intent");

  // Export physical product variants as a CSV.
  // This request uses API version 2027-01 without changing the app's
  // default Shopify API version.
  if (intent === "export-physical-products") {
    const submittedPassword = String(form.get("password") || "");

    if (submittedPassword !== HARDCODED_PASSWORD) {
      return {
        exportError: "Access denied: incorrect password.",
      };
    }

    try {
      const { session } = await authenticate.admin(request);

      const csvCell = (value) =>
        `"${String(value ?? "").replace(/"/g, '""')}"`;

      const withUnit = (value, unit) =>
        value == null ? "" : `${value}${unit ? ` ${unit}` : ""}`;

      const rows = [
        [
          "Product",
          "Variant",
          "SKU",
          "Weight",
          "Packed Product Size Length",
          "Packed Product Size Width",
          "Packed Product Size Height",
        ]
          .map(csvCell)
          .join(","),
      ];

      const query = `#graphql
        query PhysicalProductVariants($first: Int!, $after: String) {
          productVariants(first: $first, after: $after) {
            edges {
              cursor
              node {
                title
                sku
                product {
                  title
                  status
                }
                inventoryItem {
                  requiresShipping
                  measurement {
                    weight {
                      value
                      unit
                    }
                    packedDimensions {
                      length
                      width
                      height
                      unit
                    }
                  }
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

      let cursor = null;

      do {
        const response = await fetch(
          `https://${session.shop}/admin/api/2027-01/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": session.accessToken,
            },
            body: JSON.stringify({
              query,
              variables: { first: 250, after: cursor },
            }),
          }
        );

        const payload = await response.json();

        if (!response.ok || payload?.errors?.length) {
          const messages = payload?.errors
            ?.map((error) => error.message)
            .join("; ");

          throw new Error(
            messages || `Shopify API request failed (${response.status}).`
          );
        }

        const connection = payload?.data?.productVariants;

        if (!connection) {
          throw new Error(
            "No productVariants connection found in GraphQL response."
          );
        }

        for (const edge of connection.edges || []) {
          const variant = edge?.node;
          const inventoryItem = variant?.inventoryItem;

          // Include only variants that require shipping.
          if (!variant || inventoryItem?.requiresShipping !== true) continue;
          // Include only variants of active products that require shipping.
          if (
            !variant ||
            variant.product?.status !== "ACTIVE" ||
            inventoryItem?.requiresShipping !== true
          ) {
            continue;
          }


          const weight = inventoryItem.measurement?.weight;
          const dimensions = inventoryItem.measurement?.packedDimensions;

          rows.push(
            [
              variant.product?.title,
              variant.title,
              variant.sku,
              withUnit(weight?.value, weight?.unit),
              withUnit(dimensions?.length, dimensions?.unit),
              withUnit(dimensions?.width, dimensions?.unit),
              withUnit(dimensions?.height, dimensions?.unit),
            ]
              .map(csvCell)
              .join(",")
          );
        }

        if (!connection.pageInfo?.hasNextPage) break;

        cursor = connection.pageInfo.endCursor;

        if (!cursor) {
          throw new Error(
            "Pagination indicated another page but returned no cursor."
          );
        }
      } while (true);

      return {
        csv: `\uFEFF${rows.join("\r\n")}`,
        filename: "physical-products.csv",
      };
    } catch (error) {
      return {
        exportError:
          error instanceof Error
            ? error.message
            : "The product CSV export failed.",
      };
    }
  }

  if (
    intent !== "cleanup-recovery-tags" &&
    intent !== "cleanup-ac-revenue-recovery-tags" &&
    intent !== "cleanup-offer-eligible-tags"
  ) {
    return null;
  }

  const submittedPassword = String(form.get("password") || "");
  if (submittedPassword !== HARDCODED_PASSWORD) {
    return {
      summary: "Access denied: incorrect password.",
      customers: { checked: 0, updated: 0, edgesSeen: 0, sample: null },
      orders: { checked: 0, updated: 0, edgesSeen: 0, sample: null },
    };
  }

  const { admin } = await authenticate.admin(request);

  const parseGraphqlResult = async (resp) => {
    if (resp && typeof resp.json === "function") return await resp.json();
    return resp;
  };

  const getCustomersConn = (payload) =>
    payload?.data?.customers ?? payload?.customers ?? null;

  const getOrdersConn = (payload) =>
    payload?.data?.orders ?? payload?.orders ?? null;

  // -------- tag cleanup policy per intent --------
  const buildCleanupPolicy = (policyIntent) => {
    if (policyIntent === "cleanup-recovery-tags") {
      const TARGET_TAGS = new Set([
        "Partial-Cart-Recovery-Test",
        "Organic-Cart-Recovery-Test",
        "Recovered-Self-Checkout-Test",
      ]);

      const SUBSTRING_MATCHES = [
        "FRC",
        "PRC",
        "RC ID",
        "RC Value",
        "Partial RC",
        "Full RC",
        "80%",
      ];

      return {
        scope: "customers_and_orders",
        shouldCleanTags: (tags) =>
          Array.isArray(tags) && tags.some((tag) => TARGET_TAGS.has(tag)),
        cleanTags: (tags) => {
          if (!Array.isArray(tags)) return tags;

          let out = tags.filter((tag) => !TARGET_TAGS.has(tag));

          out = out.filter((tag) => {
            const str = String(tag || "");
            return !SUBSTRING_MATCHES.some((needle) => str.includes(needle));
          });

          return [...new Set(out)];
        },
      };
    }

    if (policyIntent === "cleanup-ac-revenue-recovery-tags") {
      const TARGET_TAGS = new Set([
        "Full-AC-Revenue-Recovery",
        "Partial-AC-Revenue-Recovery",
      ]);
      const PREFIXES_TO_REMOVE = ["FRC", "PRC"];

      return {
        scope: "customers_and_orders",
        // Exact match triggers cleanup on that record.
        shouldCleanTags: (tags) =>
          Array.isArray(tags) && tags.some((tag) => TARGET_TAGS.has(tag)),
        cleanTags: (tags) => {
          if (!Array.isArray(tags)) return tags;

          // Remove exact target tags.
          let out = tags.filter((tag) => !TARGET_TAGS.has(tag));

          // Remove any other tags that start with "FRC" or "PRC".
          out = out.filter((tag) => {
            const str = String(tag || "");
            return !PREFIXES_TO_REMOVE.some((prefix) =>
              str.startsWith(prefix)
            );
          });

          return [...new Set(out)];
        },
      };
    }

    // cleanup-offer-eligible-tags
    // Remove only tags from customers that contain
    // "5%-Offer-Eligible", "10%-Offer-Eligible", or "ACR-Email-Sent".
    if (policyIntent === "cleanup-offer-eligible-tags") {
      const TARGET_TAGS = [
        "5%-Offer-Eligible",
        "10%-Offer-Eligible",
        "ACR-Email-Sent",
      ];

      return {
        scope: "customers_only",

        shouldCleanTags: (tags) => {
          if (!Array.isArray(tags)) return false;

          return tags.some((tag) => {
            const str = String(tag || "");
            return TARGET_TAGS.some((target) => str.includes(target));
          });
        },

        cleanTags: (tags) => {
          if (!Array.isArray(tags)) return tags;

          const out = tags.filter((tag) => {
            const str = String(tag || "");
            return !TARGET_TAGS.some((target) => str.includes(target));
          });

          return [...new Set(out)];
        },
      };
    }
  };

  const policy = buildCleanupPolicy(intent);

  const updateCustomerTags = async (customerGid, nextTags) => {
    const tagsString = (nextTags || []).join(", ");

    const mutation = `
      mutation customerTagsUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id tags }
          userErrors { field message }
        }
      }
    `;

    const resp = await admin.graphql(mutation, {
      variables: {
        input: {
          id: customerGid,
          tags: tagsString,
        },
      },
    });

    const parsed = await parseGraphqlResult(resp);
    const errors = parsed?.data?.customerUpdate?.userErrors || [];

    if (errors.length) {
      throw new Error(errors.map((error) => error.message).join("; "));
    }
  };

  const updateOrderTags = async (orderGid, nextTags) => {
    const tagsString = (nextTags || []).join(", ");

    const mutation = `
      mutation orderTagsUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id tags }
          userErrors { field message }
        }
      }
    `;

    const resp = await admin.graphql(mutation, {
      variables: {
        input: {
          id: orderGid,
          tags: tagsString,
        },
      },
    });

    const parsed = await parseGraphqlResult(resp);
    const errors = parsed?.data?.orderUpdate?.userErrors || [];

    if (errors.length) {
      throw new Error(errors.map((error) => error.message).join("; "));
    }
  };

  const CUSTOMER_QUERY = `
    query Customers($first: Int!, $after: String) {
      customers(first: $first, after: $after) {
        edges {
          cursor
          node {
            id
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

  const ORDERS_QUERY = `
    query Orders($first: Int!, $after: String) {
      orders(first: $first, after: $after) {
        edges {
          cursor
          node {
            id
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

  let customersChecked = 0;
  let customersUpdated = 0;
  let customersEdgesSeen = 0;
  let customersSample = null;

  // Customers loop (always runs; policy decides whether to modify).
  {
    let cursor = null;

    while (true) {
      const resp = await admin.graphql(`#graphql\n${CUSTOMER_QUERY}`, {
        variables: { first: 250, after: cursor },
      });

      const data = await parseGraphqlResult(resp);
      const conn = getCustomersConn(data);

      if (!conn) {
        return {
          summary: "No customers connection found in response",
          customers: { checked: 0, updated: 0, edgesSeen: 0, sample: null },
          orders: { checked: 0, updated: 0, edgesSeen: 0, sample: null },
        };
      }

      for (const edge of conn.edges || []) {
        const node = edge?.node;
        if (!node) continue;

        customersEdgesSeen++;
        customersChecked++;

        const tags = node.tags || [];
        if (!policy.shouldCleanTags(tags)) continue;

        const nextTags = policy.cleanTags(tags);

        const originalStr = Array.isArray(tags) ? tags.join(",") : "";
        const nextStr = Array.isArray(nextTags) ? nextTags.join(",") : "";

        if (originalStr === nextStr) continue;

        await updateCustomerTags(node.id, nextTags);
        customersUpdated++;

        if (!customersSample) {
          customersSample = {
            id: node.id,
            before: tags,
            after: nextTags,
          };
        }
      }

      if (!conn.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }

  let ordersChecked = 0;
  let ordersUpdated = 0;
  let ordersEdgesSeen = 0;
  let ordersSample = null;

  // Orders loop only when policy scope includes orders.
  if (policy.scope === "customers_and_orders") {
    let cursor = null;

    while (true) {
      const resp = await admin.graphql(`#graphql\n${ORDERS_QUERY}`, {
        variables: { first: 250, after: cursor },
      });

      const data = await parseGraphqlResult(resp);
      const conn = getOrdersConn(data);

      if (!conn) {
        return {
          summary: "No orders connection found in response",
          customers: {
            checked: customersChecked,
            updated: customersUpdated,
            edgesSeen: customersEdgesSeen,
            sample: customersSample,
          },
          orders: { checked: 0, updated: 0, edgesSeen: 0, sample: null },
        };
      }

      for (const edge of conn.edges || []) {
        const node = edge?.node;
        if (!node) continue;

        ordersEdgesSeen++;
        ordersChecked++;

        const tags = node.tags || [];
        if (!policy.shouldCleanTags(tags)) continue;

        const nextTags = policy.cleanTags(tags);

        const originalStr = Array.isArray(tags) ? tags.join(",") : "";
        const nextStr = Array.isArray(nextTags) ? nextTags.join(",") : "";

        if (originalStr === nextStr) continue;

        await updateOrderTags(node.id, nextTags);
        ordersUpdated++;

        if (!ordersSample) {
          ordersSample = {
            id: node.id,
            before: tags,
            after: nextTags,
          };
        }
      }

      if (!conn.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }

  return {
    summary: `Done. Customers checked: ${customersChecked}, updated: ${customersUpdated}. Orders checked: ${ordersChecked}, updated: ${ordersUpdated}.`,
    customers: {
      checked: customersChecked,
      updated: customersUpdated,
      edgesSeen: customersEdgesSeen,
      sample: customersSample,
    },
    orders: {
      checked: ordersChecked,
      updated: ordersUpdated,
      edgesSeen: ordersEdgesSeen,
      sample: ordersSample,
    },
  };
}

export default function AdditionalPage() {
  const fetcher = useFetcher();
  const exportFetcher = useFetcher();

  const busy =
    fetcher.state !== "idle" || exportFetcher.state !== "idle";

  const [passwordValue, setPasswordValue] = React.useState("");

  React.useEffect(() => {
    const data = exportFetcher.data;

    if (!data?.csv) return;

    const blob = new Blob([data.csv], {
      type: "text/csv;charset=utf-8",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = data.filename || "physical-products.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [exportFetcher.data]);

  const submitIntent = (intentValue) => {
    if (busy) return;

    const formEl = document.getElementById("tag-cleanup-form");
    const intentEl = document.getElementById("tag-cleanup-intent");

    if (!formEl || !intentEl) return;

    intentEl.value = intentValue;
    formEl.requestSubmit();
  };

  const submitExport = () => {
    if (busy) return;

    const formData = new FormData();
    formData.set("intent", "export-physical-products");
    formData.set("password", passwordValue);

    exportFetcher.submit(formData, {
      method: "post",
    });
  };

  return (
    <s-page heading="Test Tag Cleanup">
      <s-section heading="Run cleanup">
        <s-paragraph>
          Click a button to run cleanup. All buttons share the same password.
        </s-paragraph>

        <fetcher.Form method="post" id="tag-cleanup-form">
          <input
            type="hidden"
            name="intent"
            id="tag-cleanup-intent"
            value=""
          />
          <input
            type="hidden"
            name="password"
            value={passwordValue}
          />

          <input
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            style={{ width: 260 }}
            value={passwordValue}
            onChange={(event) => setPasswordValue(event.target.value)}
          />

          <div style={{ marginTop: 12 }}>
            <s-button
              type="button"
              onClick={() => submitIntent("cleanup-recovery-tags")}
              disabled={busy}
            >
              {busy
                ? "Running..."
                : "Check & remove current test recovery tags"}
            </s-button>
          </div>

          <div style={{ marginTop: 12 }}>
            <s-button
              type="button"
              onClick={() =>
                submitIntent("cleanup-ac-revenue-recovery-tags")
              }
              disabled={busy}
            >
              {busy
                ? "Running..."
                : "Check & remove AC revenue recovery tags"}
            </s-button>
          </div>

          <div style={{ marginTop: 12 }}>
            <s-button
              type="button"
              onClick={() => submitIntent("cleanup-offer-eligible-tags")}
              disabled={busy}
            >
              {busy
                ? "Running..."
                : "Check & clear Offer-Eligible customer tags"}
            </s-button>
          </div>

          {fetcher.data?.summary ? (
            <s-paragraph style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
              {fetcher.data.summary}
            </s-paragraph>
          ) : null}
        </fetcher.Form>

        <div style={{ marginTop: 12 }}>
          <s-button
            type="button"
            onClick={submitExport}
            disabled={busy}
          >
            {exportFetcher.state !== "idle"
              ? "Exporting..."
              : "Export physical products CSV"}
          </s-button>
        </div>

        {exportFetcher.data?.exportError ? (
          <s-paragraph style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
            Export failed: {exportFetcher.data.exportError}
          </s-paragraph>
        ) : null}
      </s-section>

      <s-section slot="aside" heading="Targets">
        <s-unordered-list>
          <s-list-item>
            Button 1: removes exact tags{" "}
            <code>Partial-Cart-Recovery-Test</code>,{" "}
            <code>Organic-Cart-Recovery-Test</code>,{" "}
            <code>Recovered-Self-Checkout-Test</code> and also removes any
            other tags containing <code>FRC</code>, <code>PRC</code>,{" "}
            <code>RC ID</code>, <code>RC Value</code>,{" "}
            <code>Partial RC</code>, <code>Full RC</code>, <code>80%</code>.
          </s-list-item>

          <s-list-item>
            Button 2: exact match{" "}
            <code>Full-AC-Revenue-Recovery</code> /{" "}
            <code>Partial-AC-Revenue-Recovery</code>, removes those tags, and
            also removes any other tags that start with <code>FRC</code> or{" "}
            <code>PRC</code>.
          </s-list-item>

          <s-list-item>
            Button 3: customers only; if a customer has a tag containing{" "}
            <code>5%-Offer-Eligible</code>,{" "}
            <code>10%-Offer-Eligible</code>, or <code>ACR-Email-Sent</code>,
            removes those tags.
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}