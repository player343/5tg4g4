import { Router, type IRouter } from "express";
import { findItem, getDataset, listByTier, searchItems } from "../lib/values";

const router: IRouter = Router();

router.get("/values", (_req, res) => {
  res.json(getDataset());
});

router.get("/values/search", (req, res) => {
  const q = String(req.query["q"] ?? "");
  res.json({ query: q, items: searchItems(q, 25) });
});

router.get("/values/tier/:tier", (req, res) => {
  const tier = req.params.tier;
  res.json({ tier, items: listByTier(tier) });
});

router.get("/values/:name", (req, res) => {
  const item = findItem(req.params.name);
  if (!item) {
    res.status(404).json({ error: "not_found", query: req.params.name });
    return;
  }
  res.json(item);
});

export default router;
