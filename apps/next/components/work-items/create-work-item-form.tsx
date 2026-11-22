"use client";

import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { createWorkItemId, parseUuidV7 } from "@scarn/api/frontend-contracts";
import {
  Alert,
  Button,
  Card,
  CardContent,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";
import { useProjectPath } from "@/components/project-route-context";

type CreateWorkItemState = {
  message: string;
};

const initialState: CreateWorkItemState = {
  message: "",
};

const getFormValue = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
};

export function CreateWorkItemForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const projectPath = useProjectPath();
  const [state, setState] = useState<CreateWorkItemState>(initialState);
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsPending(true);
    setState(initialState);

    const formData = new FormData(event.currentTarget);
    const title = getFormValue(formData, "title");
    const description = getFormValue(formData, "description");

    try {
      const id = createWorkItemId();
      const scarnApiClient = getBrowserScarnApiClient();
      const { data } = await scarnApiClient.api["work-items"].post({
        id,
        projectId: parseUuidV7(projectId),
        platform: "scarn",
        platformId: null,
        platformKey: `manual-${id}`,
        url: null,
        title,
        description,
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        fields: null,
      });

      if (!data || typeof data.id !== "string") {
        throw new Error("Failed to create work item");
      }

      router.push(projectPath("work-items", data.id));
      router.refresh();
    } catch (error) {
      setState({
        message: error instanceof Error ? error.message : "Unexpected error",
      });
      setIsPending(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <Stack
          spacing={2.5}
          component="form"
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <div>
            <Typography variant="h5">Create new work item</Typography>
          </div>
          <TextField name="title" label="Add a title" required fullWidth />
          <TextField
            name="description"
            label="Add a description"
            multiline
            minRows={6}
            fullWidth
            required
          />
          {state.message ? (
            <Alert severity="error">{state.message}</Alert>
          ) : null}
          <Button
            type="submit"
            variant="contained"
            disabled={isPending}
            sx={{ alignSelf: "flex-start" }}
          >
            Create
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
