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

  const getCustomersConn = (payload) => payload?.data?.customers ?? payload?.customers ?? null;
  const getOrdersConn = (payload) => payload?.data?.orders ?? payload?.orders ?? null;

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
        shouldCleanTags: (tags) => Array.isArray(tags) && tags.some((t) => TARGET_TAGS.has(t)),
        cleanTags: (tags) => {
          if (!Array.isArray(tags)) return tags;

          let out = tags.filter((t) => !TARGET_TAGS.has(t));

          out = out.filter((t) => {
            const str = String(t || "");
            return !SUBSTRING_MATCHES.some((needle) => str.includes(needle));
          });

          return [...new Set(out)];
        },
      };
    }

    if (policyIntent === "cleanup-ac-revenue-recovery-tags") {
      const TARGET_TAGS = new Set(["Full-AC-Revenue-Recovery", "Partial-AC-Revenue-Recovery"]);
      const PREFIXES_TO_REMOVE = ["FRC", "PRC"];

      return {
        scope: "customers_and_orders",
        // exact match triggers cleanup on that record
        shouldCleanTags: (tags) => Array.isArray(tags) && tags.some((t) => TARGET_TAGS.has(t)),
        cleanTags: (tags) => {
          if (!Array.isArray(tags)) return tags;

          // remove exact target tags
          let out = tags.filter((t) => !TARGET_TAGS.has(t));

          // remove any other tags that start with "FRC" or "PRC"
          out = out.filter((t) => {
            const str = String(t || "");
            return !PREFIXES_TO_REMOVE.some((prefix) => str.startsWith(prefix));
          });

          return [...new Set(out)];
        },
      };
    }

    // cleanup-offer-eligible-tags
    // remove all tags from customers ONLY that CONTAIN "5%-Offer-Eligible", "10%-Offer-Eligible", or "ACR-Email-Sent"
    return {
      scope: "customers_only",
      shouldCleanTags: (tags) => {
        if (!Array.isArray(tags)) return false;
        return tags.some((t) => {
          const str = String(t || "");
          return str.includes("5%-Offer-Eligible") || str.includes("10%-Offer-Eligible") || str.includes("ACR-Email-Sent");
        });
      },
      cleanTags: () => {
        // remove ALL tags for matching customers
        return [];
      },
    };
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
    if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
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
    if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
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

  // Customers loop (always runs; policy decides whether to modify)
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

        if (!customersSample) customersSample = { id: node.id, before: tags, after: nextTags };
      }

      if (!conn.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }

  let ordersChecked = 0;
  let ordersUpdated = 0;
  let ordersEdgesSeen = 0;
  let ordersSample = null;

  // Orders loop only when policy scope includes orders
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

        if (!ordersSample) ordersSample = { id: node.id, before: tags, after: nextTags };
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
  const busy = fetcher.state !== "idle";

  // Shared form ref fields
  const [passwordValue, setPasswordValue] = React.useState("");

  const submitIntent = (intentValue) => {
    if (busy) return;

    const formEl = document.getElementById("tag-cleanup-form");
    const intentEl = document.getElementById("tag-cleanup-intent");

    if (!formEl || !intentEl) return;

    intentEl.value = intentValue;

    // Submit the shared form
    formEl.requestSubmit();
  };

  return (
    <s-page heading="Test Tag Cleanup">
      <s-section heading="Run cleanup">
        <s-paragraph>
          Click a button to run cleanup. All buttons share the same password.
        </s-paragraph>

        <fetcher.Form method="post" id="tag-cleanup-form">
          {/* Single password block */}
          <input type="hidden" name="intent" id="tag-cleanup-intent" value="" />
          <input type="hidden" name="password" value={passwordValue} />

          <input
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            style={{ width: 260 }}
            value={passwordValue}
            onChange={(e) => setPasswordValue(e.target.value)}
          />

          <div style={{ marginTop: 12 }}>
            <s-button type="button" onClick={() => submitIntent("cleanup-recovery-tags")} disabled={busy}>
              {busy ? "Running..." : "Check & remove current test recovery tags"}
            </s-button>
          </div>

          <div style={{ marginTop: 12 }}>
            <s-button
              type="button"
              onClick={() => submitIntent("cleanup-ac-revenue-recovery-tags")}
              disabled={busy}
            >
              {busy ? "Running..." : "Check & remove AC revenue recovery tags"}
            </s-button>
          </div>

          <div style={{ marginTop: 12 }}>
            <s-button
              type="button"
              onClick={() => submitIntent("cleanup-offer-eligible-tags")}
              disabled={busy}
            >
              {busy ? "Running..." : "Check & clear Offer-Eligible customer tags"}
            </s-button>
          </div>

          {fetcher.data?.summary ? (
            <s-paragraph style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
              {fetcher.data.summary}
            </s-paragraph>
          ) : null}
        </fetcher.Form>
      </s-section>

      <s-section slot="aside" heading="Targets">
        <s-unordered-list>
          <s-list-item>
            Button 1: removes exact tags{" "}
            <code>Partial-Cart-Recovery-Test</code>, <code>Organic-Cart-Recovery-Test</code>,{" "}
            <code>Recovered-Self-Checkout-Test</code> and also removes any other tags containing{" "}
            <code>FRC</code>, <code>PRC</code>, <code>RC ID</code>, <code>RC Value</code>,{" "}
            <code>Partial RC</code>, <code>Full RC</code>, <code>80%</code>.
          </s-list-item>

          <s-list-item>
            Button 2: exact match{" "}
            <code>Full-AC-Revenue-Recovery</code> / <code>Partial-AC-Revenue-Recovery</code>, remove those tags,
            and also remove any other tags that start with <code>FRC</code> or <code>PRC</code>.
          </s-list-item>

          <s-list-item>
            Button 3: customers only; if a customer has a tag containing{" "}
            <code>5%-Offer-Eligible</code> or <code>10%-Offer-Eligible</code>, remove <em>all</em> their tags.
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}