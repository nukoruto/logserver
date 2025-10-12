import eventRepository from './eventRepository.js';

type CreateSchema = () => Promise<void>;

const { createSchema } = eventRepository as {
  createSchema: CreateSchema;
};

export { createSchema };
