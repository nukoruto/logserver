import * as eventRepository from './eventRepository.js';

type CreateSchema = () => Promise<void>;

type EventRepositoryModule = {
  createSchema: CreateSchema;
};

const repository = eventRepository as EventRepositoryModule;

const { createSchema } = repository;

export { createSchema };
