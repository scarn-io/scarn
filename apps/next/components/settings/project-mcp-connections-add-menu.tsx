"use client";

import { useState } from "react";
import { Box, Button, Menu, MenuItem } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import type { ManagedConnectionPresetContract } from "@scarn/api/frontend-contracts";

/** "Add connection": a menu of the presets the project can still connect. */
export function AddConnectionMenu({
  presets,
  onSelect,
}: {
  presets: ManagedConnectionPresetContract[];
  onSelect: (preset: ManagedConnectionPresetContract) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <Box>
      <Button
        variant="outlined"
        startIcon={<AddIcon />}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => {
          setAnchor(event.currentTarget);
        }}
      >
        Add connection
      </Button>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null);
        }}
      >
        {presets.map((preset) => (
          <MenuItem
            key={preset.key}
            onClick={() => {
              setAnchor(null);
              onSelect(preset);
            }}
          >
            {preset.label}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}
