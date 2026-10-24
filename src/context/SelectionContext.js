import { createContext } from 'react';

export const SelectionContext = createContext({
  selectedImageIds: new Set(),
  setSelectedImageIds: () => {},
});
