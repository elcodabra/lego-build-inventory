---
name: get-started
description: First steps with My Bricks Builder. Use when the user has just connected the app or asks how to start. Explains the three ways to add bricks (photo of a pile, a parts list, set numbers) and offers to suggest models.
---

# Getting started with My Bricks Builder

1. Ask the user how they want to add their bricks:
   - a photo of the pile of parts (pass the image file to `parts_from_pile_photo`),
   - a parts list (`inventory_import`, CSV with part, color, qty),
   - set numbers they own (`inventory_add_set`).
   DUPLO bricks work too, by their BrickLink numbers.
2. Show the recognised list briefly and fix doubts with `inventory_update`.
3. Call `ideas_suggest`: the card shows real pictures of models built from the user's own parts.
4. When the user picks one, call `idea_build`, then `show_build`. Offer step pictures or a video only on request.

Never show pictures from the web or of official sets. Not affiliated with the LEGO Group.
