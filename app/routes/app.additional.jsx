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
  if (intent !== "cleanup-recovery-tags") return null;

  const submittedPassword = String(form.get("password") || "");
  if (submittedPassword !== HARDCODED_PASSWORD) {
    return {
      summary: "Access denied: incorrect password.",
      customers: { checked: 0, updated: 0, edgesSeen: 0, sample: null },
      orders: { checked: 0, updated: 0, edgesSeen: 0, sample: null },
    };
  }

  const { admin } = await authenticate.admin(request);

  console.log("admin.rest:", admin?.rest);
  console.log("admin keys:", admin ? Object.keys(admin) : admin);

  const TARGET_TAGS = new Set([
    "Partial-Cart-Recovery-Test",
    "Organic-Cart-Recovery-Test",
    "Recovered-Self-Checkout-Test"
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

  const extractNumericIdFromGid = (gid) => {
    const s = String(gid || "");
    const parts = s.split("/");
    return parts[parts.length - 1];
  };

  const shouldCleanTags = (tags) => {
    if (!Array.isArray(tags)) return false;
    return tags.some((t) => TARGET_TAGS.has(t));
  };

  const cleanTags = (tags) => {
    if (!Array.isArray(tags)) return tags;

    let out = tags.filter((t) => !TARGET_TAGS.has(t));

    out = out.filter((t) => {
      const str = String(t || "");
      return !SUBSTRING_MATCHES.some((needle) => str.includes(needle));
    });

    return [...new Set(out)];
  };

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

    
    console.log("GraphQL mutation raw resp:", resp);

    
    const data = await parseGraphqlResult(resp);
    console.log("GraphQL mutation parsed data:", data);

    const parsed = await parseGraphqlResult(resp);
    const errors = parsed?.data?.customerUpdate?.userErrors || [];
    if (errors.length) throw new Error(errors.map(e => e.message).join("; "));
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

    // Note: OrderInput is for orderUpdate, takes id + tags
    const resp = await admin.graphql(mutation, {
      variables: {
        input: {
          id: orderGid,
          tags: tagsString,
        },
      },
    });

    
    console.log("GraphQL mutation raw resp:", resp);

    
    const data = await parseGraphqlResult(resp);
    console.log("GraphQL mutation parsed data:", data);

    const parsed = await parseGraphqlResult(resp);
    const errors = parsed?.data?.orderUpdate?.userErrors || [];
    if (errors.length) throw new Error(errors.map(e => e.message).join("; "));
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

  const getCustomersConn = (payload) =>
    payload?.data?.customers ?? payload?.customers ?? null;

  const getOrdersConn = (payload) =>
    payload?.data?.orders ?? payload?.orders ?? null;

  const parseGraphqlResult = async (resp) => {
    if (resp && typeof resp.json === "function") return await resp.json();
    return resp;
  };

  let customersChecked = 0;
  let customersUpdated = 0;
  let customersEdgesSeen = 0;
  let customersSample = null;

  // Customers: iterate through all pages
  {
    let cursor = null;
    while (true) {
      const resp = await admin.graphql(
        `#graphql\n${CUSTOMER_QUERY}`,
        { variables: { first: 250, after: cursor } }
      );

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
        if (!shouldCleanTags(tags)) continue;

        const nextTags = cleanTags(tags);

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

  // Orders: iterate through all pages
  {
    let cursor = null;
    while (true) {
      const resp = await admin.graphql(
        `#graphql\n${ORDERS_QUERY}`,
        { variables: { first: 250, after: cursor } }
      );

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
        if (!shouldCleanTags(tags)) continue;

        const nextTags = cleanTags(tags);

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

  return (
    <s-page heading="Test Tag Cleanup">
      <s-section heading="Run cleanup">
        <s-paragraph>
          Click the button to remove recovery-test tags from all customers and
          orders. It removes:
          <br />
          - Exact tags: <code>Partial-Cart-Recovery-Test</code>,{" "} <code>Recovered-Self-Checkout-Test</code> and{" "}
          <code>Organic-Cart-Recovery-Test</code>
          <br />
          - Any other tags containing: <code>FRC</code>, <code>PRC</code>,{" "}
          <code>RC ID</code>, <code>Partial RC</code>,{" "}
          <code>Full RC</code>, <code>80%</code>
        </s-paragraph>

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="cleanup-recovery-tags" />

          <input
            name="password"
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            style={{ width: 260 }}
          />

          <s-button type="submit" disabled={fetcher.state !== "idle"}>
            {fetcher.state !== "idle" ? "Running..." : "Check & remove tags"}
          </s-button>
        </fetcher.Form>

        {fetcher.data?.summary ? (
          <s-paragraph style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
            {fetcher.data.summary}
          </s-paragraph>
        ) : null}
      </s-section>

      <s-section slot="aside" heading="Targets">
        <s-unordered-list>
          <s-list-item>
            Exact match removals: <code>Partial-Cart-Recovery-Test</code>,{" "} <code>Recovered-Self-Checkout-Test</code> and{" "}
            <code>Organic-Cart-Recovery-Test</code>
          </s-list-item>
          <s-list-item>
            Substring removals: <code>FRC</code>, <code>PRC</code>,{" "}
            <code>RC ID</code>, <code>Partial RC</code>,{" "}
            <code>Full RC</code>, <code>80%</code>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}