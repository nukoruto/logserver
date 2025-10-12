import type { Router } from 'express';
import eventsRouter from './events.js';

const legacyEventsRouter: unknown = eventsRouter;
const typedEventsRouter = legacyEventsRouter as Router;

export default typedEventsRouter;
