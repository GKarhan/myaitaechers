/**
 * Compatibility surface for established teacher authoring routes that predate
 * the OpenAPI contract. Keep this isolated from generated code so regenerating
 * the documented client cannot silently remove a live teacher workflow.
 */
import { useMutation, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

type RequestOptions = { query?: UseQueryOptions<any[], Error> };
type LessonId = { lessonId: number };
type LessonExerciseInput = LessonId & { exerciseId?: number; data?: Record<string, unknown> };

export const getGetLessonExercisesQueryKey = (lessonId: number) =>
  [`/api/lessons/${lessonId}/exercises`] as const;

export function useGetLessonExercises(lessonId: number, options?: RequestOptions) {
  return useQuery<any[], Error>({
    queryKey: getGetLessonExercisesQueryKey(lessonId),
    queryFn: ({ signal }) =>
      customFetch(`/api/lessons/${lessonId}/exercises`, { method: "GET", signal }),
    ...options?.query,
  });
}

export function useMapLessonWithAI() {
  return useMutation({
    mutationKey: ["mapLessonWithAI"],
    mutationFn: ({ lessonId }: LessonId) =>
      customFetch(`/api/lessons/${lessonId}/map`, { method: "POST" }),
  });
}

export function useCreateLessonExercise() {
  return useMutation({
    mutationKey: ["createLessonExercise"],
    mutationFn: ({ lessonId, data }: LessonExerciseInput) =>
      customFetch(`/api/lessons/${lessonId}/exercises`, {
        method: "POST",
        body: JSON.stringify(data ?? {}),
      }),
  });
}

export function useUpdateLessonExercise() {
  return useMutation({
    mutationKey: ["updateLessonExercise"],
    mutationFn: ({ lessonId, exerciseId, data }: LessonExerciseInput) =>
      customFetch(`/api/lessons/${lessonId}/exercises/${exerciseId}/update`, {
        method: "POST",
        body: JSON.stringify(data ?? {}),
      }),
  });
}

export function useDeleteLessonExercise() {
  return useMutation({
    mutationKey: ["deleteLessonExercise"],
    mutationFn: ({ lessonId, exerciseId }: LessonExerciseInput) =>
      customFetch(`/api/lessons/${lessonId}/exercises/${exerciseId}`, { method: "DELETE" }),
  });
}

export function useApproveAllLessonExercises() {
  return useMutation({
    mutationKey: ["approveAllLessonExercises"],
    mutationFn: ({ lessonId }: LessonId) =>
      customFetch(`/api/lessons/${lessonId}/exercises/approve-all`, { method: "POST" }),
  });
}

export function useCreateLessonTopic() {
  return useMutation({
    mutationKey: ["createLessonTopic"],
    mutationFn: ({ lessonId, data }: LessonExerciseInput) =>
      customFetch(`/api/lessons/${lessonId}/topics`, {
        method: "POST",
        body: JSON.stringify(data ?? {}),
      }),
  });
}

export function useDeleteLessonTopic() {
  return useMutation({
    mutationKey: ["deleteLessonTopic"],
    mutationFn: ({ lessonId, topicId }: LessonId & { topicId: number }) =>
      customFetch(`/api/lessons/${lessonId}/topics/${topicId}`, { method: "DELETE" }),
  });
}

export function useReorderLessonTopics() {
  return useMutation({
    mutationKey: ["reorderLessonTopics"],
    mutationFn: ({ lessonId, data }: LessonExerciseInput) =>
      customFetch(`/api/lessons/${lessonId}/topics/reorder`, {
        method: "POST",
        body: JSON.stringify(data ?? {}),
      }),
  });
}

export function useReorderLessonNodes() {
  return useMutation({
    mutationKey: ["reorderLessonNodes"],
    mutationFn: ({ lessonId, data }: LessonExerciseInput) =>
      customFetch(`/api/lessons/${lessonId}/nodes/reorder`, {
        method: "POST",
        body: JSON.stringify(data ?? {}),
      }),
  });
}