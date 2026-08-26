import { Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    // Keep the original template behavior for the /auth flow
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // If the user is not logged in, show the “Log in” form
  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>
          Abandoned Checkout Recovered Revenue Report
        </h1>

        <p className={styles.text}>
          Visualize recovered revenue from abandoned checkout recovery over
          selectable time ranges and export the results as a CSV.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="e.g: my-shop-domain.myshopify.com"
              />
              <span>Enter your Shopify shop domain</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}

        <div className={styles.featureGrid}>
          <div className={styles.featureCard}>
            <strong>Revenue over time</strong>
            <div className={styles.cardText}>
              Generate a graph of recovered revenue using your recovery events.
            </div>
          </div>

          <div className={styles.featureCard}>
            <strong>Selectable buckets</strong>
            <div className={styles.cardText}>
              Choose how data is grouped: by day, week, month, or year.
            </div>
          </div>

          <div className={styles.featureCard}>
            <strong>Export to CSV</strong>
            <div className={styles.cardText}>
              Download the chart data as a CSV for analysis and reporting.
            </div>
          </div>
        </div>

        <div className={styles.howItWorks}>
          <h2 className={styles.subHeading}>How it works</h2>
          <ol className={styles.list}>
            <li>
              Pick a time range (e.g., last 30 / 90 days, or a custom window).
            </li>
            <li>
              Choose your bucket size (day/week/month/year) for chart and CSV.
            </li>
            <li>
              View the recovered revenue graph and export the underlying data.
            </li>
          </ol>
        </div>
        
        <div className={styles.ctaRow}>
          <a className={styles.ctaPrimary} href="/app/report">
            View report
          </a>
          <a className={styles.ctaSecondary} href="/app/export">
            Export CSV
          </a>
        </div>
      </div>
    </div>
  );
}