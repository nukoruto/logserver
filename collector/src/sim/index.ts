import * as scenario from './scenario';
import * as normalGenerator from './generator/normalGenerator';
import * as anomalyInjector from './generator/anomalyInjector';
import * as timeDeviationDetector from './detector/timeDeviationDetector';
import * as protocolValidator from './detector/protocolValidator';
import { labelSequence } from './labeler';
import { persistSimulationRun } from './persistence/simWriter';

const sim = {
  scenario,
  normalGenerator,
  anomalyInjector,
  timeDeviationDetector,
  protocolValidator,
  labelSequence,
  persistSimulationRun,
};

export {
  anomalyInjector,
  labelSequence,
  normalGenerator,
  persistSimulationRun,
  protocolValidator,
  scenario,
  timeDeviationDetector,
};

export default sim;
