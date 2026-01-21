import { cronJobs } from "convex/server";
import { api } from "./_generated/api";

const crons = cronJobs();

crons.cron(
  "star-vault-daily-sync",
  "0 7 * * *",
  api.starVault.syncStarVault,
  { fetchRepos: true, contentLimit: 50, embeddingLimit: 20, syncType: "cron" },
);

export default crons;
