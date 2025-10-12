import { Router } from 'express';
import type { Request, Response } from 'express';
import auth from '../middleware/auth';
import logCapture from '../middleware/logCapture';
import asyncHandler from '../utils/asyncHandler';
import logService, { type ListEventsQuery } from '../services/logService';

const router = Router();

router.use(auth);
router.use(logCapture);

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const event = await logService.ingestEvent(req.body ?? {});
    res.status(201).json({ data: event });
  })
);

router.post(
  '/batch',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const events = await logService.ingestBatch(Array.isArray(req.body) ? req.body : []);
    res.status(201).json({ data: { inserted: events.length } });
  })
);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await logService.listEvents(req.query as ListEventsQuery);
    res.json({ data: result });
  })
);

router.get(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await logService.listEvents({
      ...(req.query as ListEventsQuery),
      session_id: req.params.sessionId,
    });
    res.json({ data: result });
  })
);

export { router };
export default router;
