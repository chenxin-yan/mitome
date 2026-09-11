import { type TurnEventDto, TurnEventDtoSchema } from "../../src/index.js";

declare const schemaDto: typeof TurnEventDtoSchema.Type;
declare const handWrittenDto: TurnEventDto;

const schemaTypeIsDto: TurnEventDto = schemaDto;
const dtoIsSchemaType: typeof TurnEventDtoSchema.Type = handWrittenDto;

void schemaTypeIsDto;
void dtoIsSchemaType;
