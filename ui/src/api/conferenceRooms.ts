import type {
  Approval,
  AddConferenceRoomComment,
  ConferenceRoom,
  ConferenceRoomComment,
  CreateConferenceRoom,
  RequestConferenceRoomDecision,
  UpdateConferenceRoom,
} from "@paperclipai/shared";
import { api } from "./client";

export const conferenceRoomsApi = {
  list: (companyId: string) => api.get<ConferenceRoom[]>(`/companies/${companyId}/conference-rooms`),
  create: (companyId: string, data: CreateConferenceRoom) =>
    api.post<ConferenceRoom>(`/companies/${companyId}/conference-rooms`, data),
  get: (roomId: string) => api.get<ConferenceRoom>(`/conference-rooms/${roomId}`),
  update: (roomId: string, data: UpdateConferenceRoom) =>
    api.patch<ConferenceRoom>(`/conference-rooms/${roomId}`, data),
  listComments: (roomId: string) => api.get<ConferenceRoomComment[]>(`/conference-rooms/${roomId}/comments`),
  addComment: (roomId: string, data: AddConferenceRoomComment) =>
    api.post<ConferenceRoomComment>(`/conference-rooms/${roomId}/comments`, data),
  requestBoardDecision: (roomId: string, data: RequestConferenceRoomDecision) =>
    api.post<Approval>(`/conference-rooms/${roomId}/request-board-decision`, data),
  listForIssue: (issueId: string) => api.get<ConferenceRoom[]>(`/issues/${issueId}/conference-rooms`),
  createForIssue: (issueId: string, data: CreateConferenceRoom) =>
    api.post<ConferenceRoom>(`/issues/${issueId}/conference-rooms`, data),
};
