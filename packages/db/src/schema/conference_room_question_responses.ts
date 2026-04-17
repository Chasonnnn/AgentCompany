import { index, pgTable, timestamp, uniqueIndex, uuid, text } from "drizzle-orm/pg-core";
import type { ConferenceRoomQuestionResponseStatus } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { conferenceRoomComments } from "./conference_room_comments.js";
import { conferenceRooms } from "./conference_rooms.js";

export const conferenceRoomQuestionResponses = pgTable(
  "conference_room_question_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    conferenceRoomId: uuid("conference_room_id").notNull().references(() => conferenceRooms.id, { onDelete: "cascade" }),
    questionCommentId: uuid("question_comment_id")
      .notNull()
      .references(() => conferenceRoomComments.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").$type<ConferenceRoomQuestionResponseStatus>().notNull().default("pending"),
    repliedCommentId: uuid("replied_comment_id").references(() => conferenceRoomComments.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roomIdx: index("conference_room_question_responses_room_idx").on(table.conferenceRoomId),
    questionIdx: index("conference_room_question_responses_question_idx").on(table.questionCommentId),
    agentIdx: index("conference_room_question_responses_agent_idx").on(table.agentId),
    roomStatusIdx: index("conference_room_question_responses_room_status_idx").on(table.conferenceRoomId, table.status),
    questionAgentIdx: uniqueIndex("conference_room_question_responses_question_agent_idx").on(
      table.questionCommentId,
      table.agentId,
    ),
  }),
);
