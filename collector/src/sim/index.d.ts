import * as scenario from './scenario';
import * as normalGenerator from './generator/normalGenerator';
import * as anomalyInjector from './generator/anomalyInjector';
import * as timeDeviationDetector from './detector/timeDeviationDetector';
import * as protocolValidator from './detector/protocolValidator';
import { labelSequence } from './labeler';
import { persistSimulationRun } from './persistence/simWriter';

declare const sim: {
  scenario: typeof scenario;
  normalGenerator: typeof normalGenerator;
  anomalyInjector: typeof anomalyInjector;
  timeDeviationDetector: typeof timeDeviationDetector;
  protocolValidator: typeof protocolValidator;
  labelSequence: typeof labelSequence;
  persistSimulationRun: typeof persistSimulationRun;
};

export { anomalyInjector, labelSequence, normalGenerator, persistSimulationRun, protocolValidator, scenario, timeDeviationDetector };
export default sim;
