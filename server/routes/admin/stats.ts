import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { analyticsService } from '../../services/analytics.service';
import { logger } from '../../utils/logger';

const router = Router();

// All routes require admin authentication
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

/**
 * GET /api/admin/stats/overview
 * Get core metrics summary.
 */
router.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dateFrom = req.query.from as string | undefined;
    const dateTo = req.query.to as string | undefined;

    const overview = analyticsService.getOverview(dateFrom, dateTo);
    const intentDistribution = analyticsService.getIntentDistribution(dateFrom, dateTo);

    res.json({
      code: 0,
      data: {
        ...overview,
        intentDistribution,
      },
      message: 'ok',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/stats/satisfaction-trend
 * Get satisfaction trend data over time.
 */
router.get('/satisfaction-trend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dateFrom = req.query.from as string | undefined;
    const dateTo = req.query.to as string | undefined;
    const granularity = (req.query.granularity as string) || 'day';

    const trend = analyticsService.getSatisfactionTrend(dateFrom, dateTo);

    // If granularity is week/month, aggregate the daily data
    let aggregatedTrend = trend;
    if (granularity === 'week' && trend.length > 0) {
      aggregatedTrend = aggregateByWeek(trend);
    } else if (granularity === 'month' && trend.length > 0) {
      aggregatedTrend = aggregateByMonth(trend);
    }

    logger.debug({ granularity, dataPoints: aggregatedTrend.length }, 'Satisfaction trend generated');

    res.json({ code: 0, data: aggregatedTrend, message: 'ok' });
  } catch (err) {
    next(err);
  }
});

/**
 * Aggregate daily trend data into weekly buckets.
 */
function aggregateByWeek(
  trend: Array<{ date: string; avgRating: number; count: number }>,
): Array<{ date: string; avgRating: number; count: number }> {
  const weekMap = new Map<string, { totalWeight: number; totalCount: number }>();

  for (const item of trend) {
    const d = new Date(item.date);
    // Get the Monday of the week
    const dayOfWeek = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((dayOfWeek + 6) % 7));
    const weekKey = monday.toISOString().slice(0, 10);

    const existing = weekMap.get(weekKey) || { totalWeight: 0, totalCount: 0 };
    if (item.count > 0) {
      // Weighted aggregation: each day's avgRating contributes proportionally
      // to its sample count so days with more ratings carry more weight.
      existing.totalWeight += item.avgRating * item.count;
      existing.totalCount += item.count;
    }
    weekMap.set(weekKey, existing);
  }

  return Array.from(weekMap.entries())
    .map(([date, data]) => ({
      date,
      avgRating: data.totalCount > 0
        ? Math.round((data.totalWeight / data.totalCount) * 100) / 100
        : 0,
      count: data.totalCount,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Aggregate daily trend data into monthly buckets.
 */
function aggregateByMonth(
  trend: Array<{ date: string; avgRating: number; count: number }>,
): Array<{ date: string; avgRating: number; count: number }> {
  const monthMap = new Map<string, { totalWeight: number; totalCount: number }>();

  for (const item of trend) {
    const monthKey = item.date.slice(0, 7); // YYYY-MM
    const existing = monthMap.get(monthKey) || { totalWeight: 0, totalCount: 0 };
    if (item.count > 0) {
      // Weighted aggregation: each day's avgRating contributes proportionally
      // to its sample count so days with more ratings carry more weight.
      existing.totalWeight += item.avgRating * item.count;
      existing.totalCount += item.count;
    }
    monthMap.set(monthKey, existing);
  }

  return Array.from(monthMap.entries())
    .map(([date, data]) => ({
      date,
      avgRating: data.totalCount > 0
        ? Math.round((data.totalWeight / data.totalCount) * 100) / 100
        : 0,
      count: data.totalCount,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export default router;
