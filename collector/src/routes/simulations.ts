import type { Router } from 'express';
import simulationsRouter from './simulations.js';

const legacySimulationsRouter: unknown = simulationsRouter;
const typedSimulationsRouter = legacySimulationsRouter as Router;

export default typedSimulationsRouter;
